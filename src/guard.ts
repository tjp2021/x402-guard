/** Serialized, durable composition root. This is the supported payment API. */

import { evaluate, quoteHash } from "./evaluate.js";
import { isLoadedPolicy } from "./load.js";
import type { LoadedPolicy } from "./load.js";
import { Ledger } from "./ledger.js";
import type { Entry, IndeterminateReason } from "./ledger.js";
import { SETTLEMENT_PROFILE } from "./policy.js";
import type { Policy, Quote, Verdict } from "./policy.js";
import type { Clock, LedgerStore, ChainReader } from "./ports.js";
import {
  reconcileHold as reconcileOne,
  sweep,
  type ReconcileOptions,
  type ReconcileResult,
} from "./reconcile.js";

export interface GuardOptions {
  readonly loadedPolicy: LoadedPolicy;
  readonly store: LedgerStore;
  readonly chain: ChainReader;
  readonly clock: Clock;
  /** Caller-attested approval lifetime. This is not independent human proof. */
  readonly approvalTtlMs?: number;
}

export type Authorization =
  | { readonly verdict: Verdict; readonly decision: "allow"; readonly holdId: string }
  | {
      readonly verdict: Verdict;
      readonly decision: "deny" | "require_approval";
      readonly holdId?: undefined;
    };

export class GuardFaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GuardFaultError";
  }
}

export class AuthorityExposureError extends Error {
  constructor() {
    super(
      "new payment authority is blocked by a durable in-flight or signer-exposure latch",
    );
    this.name = "AuthorityExposureError";
  }
}

interface ResolvedOptions {
  readonly loadedPolicy: LoadedPolicy;
  readonly store: LedgerStore;
  readonly chain: ChainReader;
  readonly clock: Clock;
  readonly approvalTtlMs: number;
}

const UINT256_MAX = (1n << 256n) - 1n;

export class Guard {
  private readonly approvals = new Map<string, number>();
  private fault?: GuardFaultError;
  private operationTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly ledger: Ledger,
    private readonly opts: ResolvedOptions,
  ) {}

  static async open(opts: GuardOptions): Promise<Guard> {
    if (!isLoadedPolicy(opts.loadedPolicy)) {
      throw new GuardFaultError(
        "Guard.open requires the opaque LoadedPolicy returned by loadPolicy/loadPolicyFile",
      );
    }
    validateProfile(opts.loadedPolicy.policy, opts.chain);
    const approvalTtlMs = optionMs(opts.approvalTtlMs, 10 * 60 * 1000, "approvalTtlMs");
    const openingNow = checkedNow(opts.clock);
    checkedExpiry(openingNow, approvalTtlMs);

    // A declared profile is not RPC evidence. The reader must prove readiness.
    try {
      await opts.chain.assertReady();
    } catch {
      throw new GuardFaultError("chain reader failed its readiness proof");
    }

    const ledger = Ledger.restore(await opts.store.readAll());
    const guard = new Guard(ledger, {
      loadedPolicy: opts.loadedPolicy,
      store: opts.store,
      chain: opts.chain,
      clock: opts.clock,
      approvalTtlMs,
    });
    await guard.reconcile();
    return guard;
  }

  /**
   * Record the in-process caller's approval assertion for one quote and one use.
   * This deliberately does not claim a human or external authority was verified.
   */
  async attestCallerApproval(quote: Quote): Promise<void> {
    this.assertHealthy();
    const safe = snapshotQuote(quote);
    await this.exclusive(async () => {
      this.assertHealthy();
      const now = checkedNow(this.opts.clock);
      this.approvals.set(
        quoteHash(safe),
        checkedExpiry(now, this.opts.approvalTtlMs),
      );
    });
  }

  async authorize(quote: Quote): Promise<Authorization> {
    this.assertHealthy();
    const safeQuote = snapshotQuote(quote);
    return this.exclusive(async () => {
      this.assertHealthy();
      if (this.ledger.blocksNewAuthority()) throw new AuthorityExposureError();
      const now = checkedNow(this.opts.clock);
      const { policy, hash } = this.opts.loadedPolicy;
      const qh = quoteHash(safeQuote);
      const expiresAt = this.approvals.get(qh);
      const approval = expiresAt === undefined ? undefined : { quoteHash: qh, expiresAt };
      const verdict = freezeVerdict(
        evaluate({
          policy,
          quote: safeQuote,
          committed: this.ledger.committed(policy, now),
          paymentsLastHour: this.ledger.paymentsLastHour(now),
          policyHash: hash,
          now,
          ...(approval ? { approval } : {}),
        }),
      );

      if (verdict.decision !== "allow") {
        if (approval) this.approvals.delete(qh);
        return Object.freeze({ verdict, decision: verdict.decision });
      }

      this.approvals.delete(qh);
      const entry = this.ledger.proposeHold(safeQuote, hash, now);
      await this.persistThenApply(entry);
      return Object.freeze({ verdict, decision: "allow" as const, holdId: entry.holdId });
    });
  }

  async attachAuthorization(
    holdId: string,
    nonce: string,
    payer: string,
    validBefore: bigint,
  ): Promise<void> {
    await this.exclusive(async () => {
      this.assertHealthy();
      await this.persistThenApply(
        this.ledger.proposeAttachAuthorization(
          holdId,
          nonce,
          payer,
          validBefore,
          checkedNow(this.opts.clock),
        ),
      );
    });
  }

  /** Generic x402 creation failure is ambiguous and never releases budget. */
  async markCreationIndeterminate(
    holdId: string,
    reason: Extract<
      IndeterminateReason,
      "creation_outcome_unknown" | "authorization_unreadable"
    > = "creation_outcome_unknown",
  ): Promise<void> {
    await this.exclusive(async () => {
      this.assertHealthy();
      await this.persistThenApply(
        this.ledger.proposeIndeterminate(holdId, reason, checkedNow(this.opts.clock)),
      );
    });
  }

  /**
   * Record a facilitator claim as nonterminal, then immediately seek chain proof.
   */
  async reportSettlement(holdId: string, transaction: string): Promise<ReconcileResult> {
    return this.exclusive(async () => {
      this.assertHealthy();
      await this.persistThenApply(
        this.ledger.proposeSettlementReported(
          holdId,
          transaction,
          checkedNow(this.opts.clock),
        ),
      );
      return reconcileOne(holdId, this.reconcileOptions());
    });
  }

  async reconcileHold(holdId: string): Promise<ReconcileResult> {
    return this.exclusive(async () => {
      this.assertHealthy();
      return reconcileOne(holdId, this.reconcileOptions());
    });
  }

  async reconcile(): Promise<readonly ReconcileResult[]> {
    return this.exclusive(async () => {
      this.assertHealthy();
      return sweep(this.reconcileOptions());
    });
  }

  needsReconciliation(): readonly Entry[] {
    return this.ledger.needsReconciliation();
  }

  history(): readonly Entry[] {
    return this.ledger.history();
  }

  isFaulted(): boolean {
    return this.fault !== undefined;
  }

  private reconcileOptions(): ReconcileOptions {
    return {
      ledger: this.ledger,
      chain: this.opts.chain,
      clock: this.opts.clock,
      commit: (entry) => this.persistThenApply(entry),
    };
  }

  private async persistThenApply(entry: Entry): Promise<void> {
    try {
      await this.opts.store.append(entry);
      this.ledger.applyPersisted(entry);
    } catch (cause) {
      const fault = new GuardFaultError(
        "ledger transition was not safely committed; Guard is faulted until reopen",
        { cause },
      );
      this.fault = fault;
      throw fault;
    }
  }

  private assertHealthy(): void {
    if (this.fault) throw this.fault;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function validateProfile(policy: Policy, chain: ChainReader): void {
  let supported = false;
  try {
    const p = chain.profile;
    supported =
      typeof p === "object" &&
      p !== null &&
      p.chainId === SETTLEMENT_PROFILE.chainId &&
      p.network === SETTLEMENT_PROFILE.network &&
      typeof p.asset === "string" &&
      p.asset.toLowerCase() === SETTLEMENT_PROFILE.asset.toLowerCase() &&
      p.decimals === SETTLEMENT_PROFILE.decimals &&
      p.scheme === SETTLEMENT_PROFILE.scheme;
  } catch {
    supported = false;
  }
  const policyMatches =
    policy.asset.network === SETTLEMENT_PROFILE.network &&
    policy.asset.address.toLowerCase() === SETTLEMENT_PROFILE.asset.toLowerCase() &&
    policy.asset.decimals === SETTLEMENT_PROFILE.decimals;
  if (!supported || !policyMatches) {
    throw new GuardFaultError(
      "version 0.1 requires a matching Base Sepolia Circle USDC exact-settlement profile",
    );
  }
}

function optionMs(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new GuardFaultError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function checkedNow(clock: Clock): number {
  const now = clock.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new GuardFaultError("clock returned an invalid unix-millisecond timestamp");
  }
  return now;
}

function checkedExpiry(now: number, ttlMs: number): number {
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new GuardFaultError("caller-attested approval expiry exceeds safe integer range");
  }
  return expiresAt;
}

function snapshotQuote(value: Quote): Quote {
  let fields: Record<keyof Quote, unknown>;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    fields = Object.fromEntries(
      (["amount", "asset", "network", "payTo", "resource"] as const).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error();
        }
        return [key, descriptor.value];
      }),
    ) as Record<keyof Quote, unknown>;
  } catch {
    throw new GuardFaultError("quote is malformed");
  }
  if (
    typeof fields.amount !== "bigint" ||
    typeof fields.asset !== "string" ||
    typeof fields.network !== "string" ||
    typeof fields.payTo !== "string" ||
    typeof fields.resource !== "string"
  ) {
    throw new GuardFaultError("quote is malformed");
  }
  if (fields.amount < 0n || fields.amount > UINT256_MAX) {
    throw new GuardFaultError("quote amount must be an unsigned uint256 bigint");
  }
  if (Buffer.byteLength(fields.resource, "utf8") > 8_192) {
    throw new GuardFaultError("quote resource exceeds 8192 UTF-8 bytes");
  }
  return Object.freeze({
    amount: fields.amount,
    asset: fields.asset.toLowerCase(),
    network: fields.network,
    payTo: fields.payTo.toLowerCase(),
    resource: fields.resource,
  });
}

function freezeVerdict(verdict: Verdict): Verdict {
  const budgets = Object.freeze(
    verdict.budgets.map((budget) => Object.freeze({ ...budget })),
  );
  return Object.freeze({ ...verdict, quote: verdict.quote, budgets });
}

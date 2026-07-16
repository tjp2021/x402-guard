/** Strict append-only payment state. Proposed events are inert until applied. */

import { createHash } from "node:crypto";
import type { Atomic } from "./amount.js";
import type { Policy, Quote, EvidenceQuote, BudgetWindow } from "./policy.js";
import { SETTLEMENT_PROFILE } from "./policy.js";
import { CHAIN_UNKNOWN_REASONS } from "./ports.js";
import type {
  ChainUnknownReason,
  FinalizedBlockProof,
  PaymentStatus,
} from "./ports.js";

export const LEDGER_SCHEMA_VERSION = 1 as const;

export type HoldStatus =
  | "held"
  | "authorization_attached"
  | "indeterminate"
  | "settlement_reported"
  | "reconciling"
  | "settled"
  | "released";

export type IndeterminateReason =
  | "creation_outcome_unknown"
  | "authorization_unreadable"
  | ChainUnknownReason;

export type LedgerReason =
  | "authorized"
  | "authorization_attached"
  | IndeterminateReason
  | "settlement_reported"
  | "chain_lookup_started"
  | "settlement_verified"
  | "authorization_unused_expired";

interface EntryBase {
  readonly schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  readonly holdId: string;
  readonly status: HoldStatus;
  readonly reason: LedgerReason;
  /** Original authorization time, unix milliseconds. */
  readonly heldAt: number;
  /** Time this event was durably recorded, unix milliseconds. */
  readonly eventAt: number;
  readonly policyHash: string;
  readonly amount: Atomic;
  readonly quote: EvidenceQuote;
}

export interface AuthorizationFields {
  readonly nonce: string;
  readonly payer: string;
  /** EIP-3009 unix seconds, lossless. */
  readonly validBefore: bigint;
}

export interface HeldEntry extends EntryBase {
  readonly status: "held";
  readonly reason: "authorized";
}

export interface AuthorizationAttachedEntry extends EntryBase, AuthorizationFields {
  readonly status: "authorization_attached";
  readonly reason: "authorization_attached";
}

export type IndeterminateEntry =
  | (EntryBase & {
      readonly status: "indeterminate";
      readonly reason: IndeterminateReason;
    })
  | (EntryBase &
      AuthorizationFields & {
        readonly status: "indeterminate";
        readonly reason: IndeterminateReason;
      });

export interface SettlementReportedEntry extends EntryBase, AuthorizationFields {
  readonly status: "settlement_reported";
  readonly reason: "settlement_reported";
  readonly transactionHint: string;
}

export interface ReconcilingEntry extends EntryBase, AuthorizationFields {
  readonly status: "reconciling";
  readonly reason: "chain_lookup_started";
}

export interface SettledEntry extends EntryBase, AuthorizationFields {
  readonly status: "settled";
  readonly reason: "settlement_verified";
  readonly transaction: string;
  /** Verified settlement block time, unix milliseconds. */
  readonly settlementAt: number;
  readonly finalizedBlock: FinalizedBlockProof;
}

export interface ReleasedEntry extends EntryBase, AuthorizationFields {
  readonly status: "released";
  readonly reason: "authorization_unused_expired";
  readonly finalizedBlock: FinalizedBlockProof;
}

export type Entry =
  | HeldEntry
  | AuthorizationAttachedEntry
  | IndeterminateEntry
  | SettlementReportedEntry
  | ReconcilingEntry
  | SettledEntry
  | ReleasedEntry;

export class LedgerError extends Error {}

const WINDOW_MS: Record<BudgetWindow, number> = {
  "rolling-1h": 60 * 60 * 1000,
  "rolling-24h": 24 * 60 * 60 * 1000,
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const POLICY_HASH = /^sha256:[0-9a-f]{64}$/;
const RESOURCE_HASH = /^sha256:[0-9a-f]{64}$/;
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;
const HOLD_ID = /^hold-[1-9][0-9]*$/;
const UINT256_MAX = (1n << 256n) - 1n;
const ENTRY_BASE_KEYS = Object.freeze([
  "schemaVersion",
  "holdId",
  "status",
  "reason",
  "heldAt",
  "eventAt",
  "policyHash",
  "amount",
  "quote",
] as const);
const AUTHORIZATION_KEYS = Object.freeze(["nonce", "payer", "validBefore"] as const);
const INDETERMINATE_REASONS = new Set<string>([
  "creation_outcome_unknown",
  "authorization_unreadable",
  ...CHAIN_UNKNOWN_REASONS,
]);

export class Ledger {
  private readonly entries: Entry[] = [];
  private seq = 0;

  /** Build but do not apply a new hold. */
  proposeHold(quote: Quote, policyHash: string, now: number): HeldEntry {
    validTime(now, "heldAt");
    if (typeof quote.resource !== "string" || Buffer.byteLength(quote.resource, "utf8") > 8_192) {
      throw new LedgerError("quote.resource must be a string no longer than 8192 bytes");
    }
    const evidenceQuote: EvidenceQuote = deepFreeze({
      amount: quote.amount,
      asset: quote.asset,
      network: quote.network,
      payTo: quote.payTo,
      resourceHash: fingerprintResource(quote.resource),
    });
    return this.freezeEntry({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      holdId: `hold-${this.seq + 1}`,
      status: "held",
      reason: "authorized",
      heldAt: now,
      eventAt: now,
      policyHash,
      amount: quote.amount,
      quote: evidenceQuote,
    });
  }

  proposeAttachAuthorization(
    holdId: string,
    nonce: string,
    payer: string,
    validBefore: bigint,
    now: number,
  ): AuthorizationAttachedEntry {
    const current = this.requireCurrent(holdId);
    if (current.status !== "held") {
      throw new LedgerError(`hold ${holdId} is ${current.status}, cannot attach authorization`);
    }
    if (!NONCE.test(nonce)) throw new LedgerError("authorization nonce must be 32 bytes");
    if (!ADDRESS.test(payer)) throw new LedgerError("authorization payer must be an address");
    if (typeof validBefore !== "bigint" || validBefore < 0n) {
      throw new LedgerError("validBefore must be an unsigned bigint in unix seconds");
    }
    return this.freezeEntry({
      ...baseFrom(current, now),
      status: "authorization_attached",
      reason: "authorization_attached",
      nonce,
      payer,
      validBefore,
    });
  }

  proposeIndeterminate(
    holdId: string,
    reason: IndeterminateReason,
    now: number,
  ): IndeterminateEntry {
    const current = this.requireResolvable(holdId);
    const auth = authorizationFrom(current);
    const base = {
      ...baseFrom(current, now),
      status: "indeterminate" as const,
      reason,
    };
    return auth
      ? this.freezeEntry({ ...base, ...auth })
      : this.freezeEntry(base);
  }

  proposeSettlementReported(
    holdId: string,
    transactionHint: string,
    now: number,
  ): SettlementReportedEntry {
    const current = this.requireAuthorized(holdId);
    if (!TX_HASH.test(transactionHint)) {
      throw new LedgerError("settlement transaction hint must be a 32-byte hash");
    }
    return this.freezeEntry({
      ...baseFrom(current, now),
      status: "settlement_reported",
      reason: "settlement_reported",
      ...authorizationFromRequired(current),
      transactionHint,
    });
  }

  proposeReconciling(holdId: string, now: number): ReconcilingEntry {
    const current = this.requireAuthorized(holdId);
    return this.freezeEntry({
      ...baseFrom(current, now),
      status: "reconciling",
      reason: "chain_lookup_started",
      ...authorizationFromRequired(current),
    });
  }

  proposeSettled(
    holdId: string,
    proof: Extract<PaymentStatus, { state: "settled" }>,
    now: number,
  ): SettledEntry {
    const current = this.requireReconciling(holdId);
    return this.freezeEntry({
      ...baseFrom(current, now),
      status: "settled",
      reason: "settlement_verified",
      ...authorizationFromRequired(current),
      transaction: proof.transaction,
      settlementAt: proof.settlementAt,
      finalizedBlock: freezeFinalizedBlock(proof.finalizedBlock),
    });
  }

  proposeReleasedUnused(
    holdId: string,
    proof: Extract<PaymentStatus, { state: "unused_expired" }>,
    now: number,
  ): ReleasedEntry {
    const current = this.requireReconciling(holdId);
    return this.freezeEntry({
      ...baseFrom(current, now),
      status: "released",
      reason: "authorization_unused_expired",
      ...authorizationFromRequired(current),
      finalizedBlock: freezeFinalizedBlock(proof.finalizedBlock),
    });
  }

  /** Apply an event only after the store has durably appended it. */
  applyPersisted(entry: Entry): void {
    const safe = cloneEntry(this.validateEntry(entry));
    const previous = this.latestInternal(safe.holdId);
    this.validateTransition(previous, safe);
    this.entries.push(safe);
    const n = holdNumber(safe.holdId);
    if (n > this.seq) this.seq = n;
  }

  /** Restore only after strict storage decoding; replay still validates lifecycle. */
  static restore(entries: readonly Entry[]): Ledger {
    const ledger = new Ledger();
    for (const entry of entries) ledger.applyPersisted(entry);
    return ledger;
  }

  /** Outstanding authority never ages out; verified spend ages from settlement. */
  committed(policy: Policy, now: number): Map<string, Atomic> {
    validTime(now, "now");
    const current = this.currentInternal();
    const out = new Map<string, Atomic>();
    for (const budget of policy.budgets) {
      const since = now - WINDOW_MS[budget.window];
      let total = 0n;
      for (const entry of current) {
        if (entry.status === "released") continue;
        if (entry.status === "settled" && entry.settlementAt < since) continue;
        total += entry.amount;
      }
      out.set(budget.name, total);
    }
    return out;
  }

  /** Velocity is authorization-attempt time, not eventual settlement time. */
  paymentsLastHour(now: number): number {
    validTime(now, "now");
    const since = now - WINDOW_MS["rolling-1h"];
    return this.currentInternal().filter(
      (entry) => entry.status !== "released" && entry.heldAt >= since,
    ).length;
  }

  /** Signed nonterminal holds that can be resolved from chain proof immediately. */
  pendingChainHolds(): readonly Entry[] {
    return frozenSnapshots(
      this.currentInternal().filter(
        (entry) =>
          hasAuthorization(entry) &&
          !(entry.status === "indeterminate" && entry.reason === "authorization_unreadable") &&
          (entry.status === "settlement_reported" ||
            entry.status === "reconciling" ||
            entry.status === "indeterminate" ||
            entry.status === "authorization_attached"),
      ),
    );
  }

  /** An in-flight signing gap or signer mismatch blocks all additional authority. */
  blocksNewAuthority(): boolean {
    return this.currentInternal().some(
      (entry) =>
        entry.status === "held" ||
        (entry.status === "indeterminate" && entry.reason === "authorization_unreadable"),
    );
  }

  needsReconciliation(): readonly Entry[] {
    return frozenSnapshots(
      this.currentInternal().filter((entry) => entry.status === "indeterminate"),
    );
  }

  state(holdId: string): Entry | undefined {
    const entry = this.latestInternal(holdId);
    return entry ? cloneEntry(entry) : undefined;
  }

  history(): readonly Entry[] {
    return frozenSnapshots(this.entries);
  }

  private freezeEntry<T extends Entry>(entry: T): T {
    const safe = cloneEntry(this.validateEntry(entry));
    this.validateTransition(this.latestInternal(safe.holdId), safe);
    return safe as T;
  }

  private validateEntry(value: unknown): Entry {
    const entry = dataObject(value, "ledger entry");
    const status = entry["status"];
    const reason = entry["reason"];
    let expectedKeys: readonly string[];

    switch (status) {
      case "held":
        requireReason(reason, "authorized");
        expectedKeys = ENTRY_BASE_KEYS;
        break;
      case "authorization_attached":
        requireReason(reason, "authorization_attached");
        expectedKeys = [...ENTRY_BASE_KEYS, ...AUTHORIZATION_KEYS];
        break;
      case "indeterminate": {
        if (typeof reason !== "string" || !INDETERMINATE_REASONS.has(reason)) {
          throw new LedgerError("indeterminate entry has an invalid reason code");
        }
        const authCount = AUTHORIZATION_KEYS.filter((key) => hasOwn(entry, key)).length;
        if (authCount !== 0 && authCount !== AUTHORIZATION_KEYS.length) {
          throw new LedgerError("authorization fields must be absent or present together");
        }
        if (
          authCount === 0 &&
          reason !== "creation_outcome_unknown" &&
          reason !== "authorization_unreadable"
        ) {
          throw new LedgerError("unsigned indeterminate entry has a chain-only reason code");
        }
        expectedKeys = authCount === 0
          ? ENTRY_BASE_KEYS
          : [...ENTRY_BASE_KEYS, ...AUTHORIZATION_KEYS];
        break;
      }
      case "settlement_reported":
        requireReason(reason, "settlement_reported");
        expectedKeys = [...ENTRY_BASE_KEYS, ...AUTHORIZATION_KEYS, "transactionHint"];
        break;
      case "reconciling":
        requireReason(reason, "chain_lookup_started");
        expectedKeys = [...ENTRY_BASE_KEYS, ...AUTHORIZATION_KEYS];
        break;
      case "settled":
        requireReason(reason, "settlement_verified");
        expectedKeys = [
          ...ENTRY_BASE_KEYS,
          ...AUTHORIZATION_KEYS,
          "transaction",
          "settlementAt",
          "finalizedBlock",
        ];
        break;
      case "released":
        if (reason !== "authorization_unused_expired") {
          throw new LedgerError("released entry has an invalid reason code");
        }
        expectedKeys = [...ENTRY_BASE_KEYS, ...AUTHORIZATION_KEYS, "finalizedBlock"];
        break;
      default:
        throw new LedgerError("ledger entry has an unsupported status");
    }
    exactKeys(entry, expectedKeys, "ledger entry");

    if (entry["schemaVersion"] !== LEDGER_SCHEMA_VERSION) {
      throw new LedgerError("unsupported ledger schema version");
    }
    const holdId = entry["holdId"];
    if (typeof holdId !== "string" || !HOLD_ID.test(holdId)) {
      throw new LedgerError("invalid hold id");
    }
    holdNumber(holdId);
    const heldAt = checkedTime(entry["heldAt"], "heldAt");
    const eventAt = checkedTime(entry["eventAt"], "eventAt");
    if (eventAt < heldAt) throw new LedgerError("eventAt precedes heldAt");
    const policyHash = entry["policyHash"];
    if (typeof policyHash !== "string" || !POLICY_HASH.test(policyHash)) {
      throw new LedgerError("invalid policy hash");
    }

    const amount = entry["amount"];
    if (typeof amount !== "bigint" || amount < 0n || amount > UINT256_MAX) {
      throw new LedgerError("entry amount must be an unsigned uint256 bigint");
    }
    const quote = dataObject(entry["quote"], "entry.quote");
    exactKeys(
      quote,
      ["amount", "asset", "network", "payTo", "resourceHash"],
      "entry.quote",
    );
    if (typeof quote["amount"] !== "bigint" || quote["amount"] !== amount) {
      throw new LedgerError("entry amount must equal quote.amount");
    }
    if (quote["network"] !== SETTLEMENT_PROFILE.network) {
      throw new LedgerError("entry network is not the supported settlement network");
    }
    const asset = quote["asset"];
    if (
      typeof asset !== "string" ||
      asset.toLowerCase() !== SETTLEMENT_PROFILE.asset.toLowerCase()
    ) {
      throw new LedgerError("entry asset is not the supported settlement asset");
    }
    const payTo = quote["payTo"];
    if (typeof payTo !== "string" || !ADDRESS.test(payTo)) {
      throw new LedgerError("invalid quote payee");
    }
    const resourceHash = quote["resourceHash"];
    if (typeof resourceHash !== "string" || !RESOURCE_HASH.test(resourceHash)) {
      throw new LedgerError("invalid resource hash");
    }

    if (AUTHORIZATION_KEYS.every((key) => hasOwn(entry, key))) {
      validateAuthorization(entry);
    }

    if (status === "settlement_reported") {
      const transactionHint = entry["transactionHint"];
      if (typeof transactionHint !== "string" || !TX_HASH.test(transactionHint)) {
        throw new LedgerError("invalid settlement transaction hint");
      }
    } else if (status === "settled") {
      const transaction = entry["transaction"];
      if (typeof transaction !== "string" || !TX_HASH.test(transaction)) {
        throw new LedgerError("invalid settlement transaction");
      }
      const settlementAt = checkedTime(entry["settlementAt"], "settlementAt");
      const finalizedBlock = validateFinalizedBlock(entry["finalizedBlock"]);
      if (finalizedBlock.timestamp * 1000n < BigInt(settlementAt)) {
        throw new LedgerError("settlement occurs after its finalized observation");
      }
    } else if (status === "released" && reason === "authorization_unused_expired") {
      const finalizedBlock = validateFinalizedBlock(entry["finalizedBlock"]);
      const validBefore = entry["validBefore"] as bigint;
      if (finalizedBlock.timestamp <= validBefore) {
        throw new LedgerError("unused proof is not strictly past validBefore");
      }
    }

    return entry as unknown as Entry;
  }

  private validateTransition(previous: Entry | undefined, next: Entry): void {
    if (!previous) {
      if (next.status !== "held") throw new LedgerError("first hold event must be held");
      if (holdNumber(next.holdId) <= this.seq) {
        throw new LedgerError(`hold id ${next.holdId} is not new`);
      }
      return;
    }
    if (!sameFacts(previous, next)) throw new LedgerError("hold facts changed across events");
    if (next.eventAt < previous.eventAt) throw new LedgerError("event time moved backwards");
    if (previous.status === "settled" || previous.status === "released") {
      throw new LedgerError(`hold ${next.holdId} is terminal (${previous.status})`);
    }
    if (
      previous.status === "indeterminate" &&
      previous.reason === "authorization_unreadable" &&
      !(next.status === "indeterminate" && next.reason === "authorization_unreadable")
    ) {
      throw new LedgerError(`hold ${next.holdId} has an irreversible authority-exposure latch`);
    }

    const priorAuth = authorizationFrom(previous);
    const nextAuth = authorizationFrom(next);
    if (priorAuth && (!nextAuth || !sameAuthorization(priorAuth, nextAuth))) {
      throw new LedgerError("authorization facts changed or disappeared");
    }
    if (!priorAuth && nextAuth && next.status !== "authorization_attached") {
      throw new LedgerError("authorization may enter only through authorization_attached");
    }
    if (priorAuth && next.status === "authorization_attached") {
      throw new LedgerError("authorization_attached may not be replayed");
    }

    const allowed: Record<Exclude<HoldStatus, "settled" | "released">, readonly HoldStatus[]> = {
      held: ["authorization_attached", "indeterminate"],
      authorization_attached: ["indeterminate", "settlement_reported", "reconciling"],
      indeterminate: ["indeterminate", "settlement_reported", "reconciling"],
      settlement_reported: ["indeterminate", "reconciling"],
      reconciling: ["indeterminate", "settled", "released"],
    };
    if (!allowed[previous.status].includes(next.status)) {
      throw new LedgerError(`illegal transition ${previous.status} -> ${next.status}`);
    }
  }

  private requireCurrent(holdId: string): Entry {
    const entry = this.latestInternal(holdId);
    if (!entry) throw new LedgerError(`unknown hold ${holdId}`);
    return entry;
  }

  private requireResolvable(holdId: string): Entry {
    const entry = this.requireCurrent(holdId);
    if (entry.status === "settled" || entry.status === "released") {
      throw new LedgerError(`hold ${holdId} is ${entry.status}, cannot resolve`);
    }
    return entry;
  }

  private requireAuthorized(holdId: string): Entry & AuthorizationFields {
    const entry = this.requireResolvable(holdId);
    if (!hasAuthorization(entry)) {
      throw new LedgerError(`hold ${holdId} has no recorded signed authorization`);
    }
    return entry;
  }

  private requireReconciling(holdId: string): ReconcilingEntry {
    const entry = this.requireAuthorized(holdId);
    if (entry.status !== "reconciling") {
      throw new LedgerError(
        `hold ${holdId} must be reconciling before proof can make it terminal`,
      );
    }
    return entry;
  }

  private latestInternal(holdId: string): Entry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      if (entry.holdId === holdId) return entry;
    }
    return undefined;
  }

  private currentInternal(): Entry[] {
    const byHold = new Map<string, Entry>();
    for (const entry of this.entries) byHold.set(entry.holdId, entry);
    return [...byHold.values()];
  }
}

function baseFrom(entry: Entry, eventAt: number): EntryBase {
  validTime(eventAt, "eventAt");
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    holdId: entry.holdId,
    status: entry.status,
    reason: entry.reason,
    heldAt: entry.heldAt,
    eventAt,
    policyHash: entry.policyHash,
    amount: entry.amount,
    quote: entry.quote,
  };
}

function hasAuthorization(entry: Entry): entry is Entry & AuthorizationFields {
  return (
    "nonce" in entry &&
    typeof entry.nonce === "string" &&
    "payer" in entry &&
    typeof entry.payer === "string" &&
    "validBefore" in entry &&
    typeof entry.validBefore === "bigint"
  );
}

function authorizationFrom(entry: Entry): AuthorizationFields | undefined {
  if (!hasAuthorization(entry)) return undefined;
  return { nonce: entry.nonce, payer: entry.payer, validBefore: entry.validBefore };
}

function authorizationFromRequired(entry: Entry & AuthorizationFields): AuthorizationFields {
  return { nonce: entry.nonce, payer: entry.payer, validBefore: entry.validBefore };
}

function sameAuthorization(a: AuthorizationFields, b: AuthorizationFields): boolean {
  return a.nonce === b.nonce && a.payer === b.payer && a.validBefore === b.validBefore;
}

function sameFacts(a: Entry, b: Entry): boolean {
  return (
    a.holdId === b.holdId &&
    a.heldAt === b.heldAt &&
    a.policyHash === b.policyHash &&
    a.amount === b.amount &&
    a.quote.amount === b.quote.amount &&
    a.quote.asset === b.quote.asset &&
    a.quote.network === b.quote.network &&
    a.quote.payTo === b.quote.payTo &&
    a.quote.resourceHash === b.quote.resourceHash
  );
}

function fingerprintResource(resource: string): string {
  return `sha256:${createHash("sha256").update(resource).digest("hex")}`;
}

function holdNumber(holdId: string): number {
  const value = Number(holdId.slice("hold-".length));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LedgerError("hold id suffix must be a positive safe integer");
  }
  return value;
}

function validTime(value: number, label: string): void {
  checkedTime(value, label);
}

function checkedTime(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new LedgerError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function validateAuthorization(entry: Readonly<Record<string, unknown>>): void {
  const nonce = entry["nonce"];
  if (typeof nonce !== "string" || !NONCE.test(nonce)) {
    throw new LedgerError("invalid authorization nonce");
  }
  const payer = entry["payer"];
  if (typeof payer !== "string" || !ADDRESS.test(payer)) {
    throw new LedgerError("invalid authorization payer");
  }
  const validBefore = entry["validBefore"];
  if (
    typeof validBefore !== "bigint" ||
    validBefore < 0n ||
    validBefore > UINT256_MAX
  ) {
    throw new LedgerError("validBefore must be an unsigned uint256 bigint");
  }
}

function validateFinalizedBlock(value: unknown): FinalizedBlockProof {
  const block = dataObject(value, "finalizedBlock");
  exactKeys(block, ["chainId", "number", "hash", "timestamp"], "finalizedBlock");
  if (block["chainId"] !== SETTLEMENT_PROFILE.chainId) {
    throw new LedgerError("finalized proof is for the wrong chain");
  }
  if (typeof block["number"] !== "bigint" || block["number"] < 0n) {
    throw new LedgerError("finalized block number must be unsigned");
  }
  if (typeof block["timestamp"] !== "bigint" || block["timestamp"] < 0n) {
    throw new LedgerError("finalized block timestamp must be unsigned");
  }
  if (typeof block["hash"] !== "string" || !BLOCK_HASH.test(block["hash"])) {
    throw new LedgerError("invalid finalized block hash");
  }
  return block as unknown as FinalizedBlockProof;
}

function dataObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LedgerError(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new LedgerError(`${label} must be a plain data object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new LedgerError(`${label} may not contain symbol fields`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new LedgerError(`${label} may contain only enumerable data fields`);
    }
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new LedgerError(`${label} has unexpected or missing fields`);
  }
}

function requireReason(actual: unknown, expected: LedgerReason): void {
  if (actual !== expected) throw new LedgerError("status and reason code do not match");
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function freezeFinalizedBlock(block: FinalizedBlockProof): FinalizedBlockProof {
  return deepFreeze({
    chainId: block.chainId,
    number: block.number,
    hash: block.hash,
    timestamp: block.timestamp,
  });
}

function cloneEntry<T extends Entry>(entry: T): T {
  const clone = {
    ...entry,
    quote: { ...entry.quote },
    ...("finalizedBlock" in entry
      ? { finalizedBlock: { ...entry.finalizedBlock } }
      : {}),
  } as T;
  return deepFreeze(clone);
}

function frozenSnapshots(entries: readonly Entry[]): readonly Entry[] {
  return Object.freeze(entries.map((entry) => cloneEntry(entry)));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

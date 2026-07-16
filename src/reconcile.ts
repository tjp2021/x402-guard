/** Proof-bearing reconciliation. It proposes events; Guard persists then applies them. */

import { Ledger, LedgerError } from "./ledger.js";
import type { Entry } from "./ledger.js";
import { CHAIN_UNKNOWN_REASONS } from "./ports.js";
import type { ChainReader, Clock, PaymentStatus } from "./ports.js";

export interface ReconcileResult {
  readonly holdId: string;
  readonly outcome: "settled" | "released" | "indeterminate";
  readonly reason: string;
}

export interface ReconcileOptions {
  readonly ledger: Ledger;
  readonly chain: ChainReader;
  readonly clock: Clock;
  /** Must append/fsync before applying the proposed event. */
  readonly commit: (entry: Entry) => Promise<void>;
}

/** Reconcile every signed nonterminal hold resumed from disk. */
export async function sweep(opts: ReconcileOptions): Promise<readonly ReconcileResult[]> {
  const candidates = opts.ledger.pendingChainHolds();
  const unique = new Map(candidates.map((entry) => [entry.holdId, entry]));
  const results: ReconcileResult[] = [];
  for (const holdId of unique.keys()) results.push(await reconcileHold(holdId, opts));
  return Object.freeze(results);
}

/** Force one hold through the same proof path, regardless of staleness. */
export async function reconcileHold(
  holdId: string,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  let current = opts.ledger.state(holdId);
  if (!current) throw new LedgerError(`unknown hold ${holdId}`);
  if (current.status === "settled") {
    return result(holdId, "settled", "already_settled");
  }
  if (current.status === "released") {
    return result(holdId, "released", "already_released");
  }
  if (current.status === "indeterminate" && current.reason === "authorization_unreadable") {
    return result(holdId, "indeterminate", "authorization_unreadable");
  }

  if (!hasAuthorization(current)) {
    const reason = current.status === "indeterminate"
      ? current.reason
      : "creation_outcome_unknown";
    return result(holdId, "indeterminate", reason);
  }

  if (current.status !== "reconciling") {
    await opts.commit(opts.ledger.proposeReconciling(holdId, checkedNow(opts.clock)));
    current = opts.ledger.state(holdId)!;
  }
  if (!hasAuthorization(current)) {
    throw new LedgerError(`hold ${holdId} lost authorization during reconciliation`);
  }

  let status: unknown;
  try {
    status = await opts.chain.findPayment({
      quote: current.quote,
      nonce: current.nonce,
      payer: current.payer,
      validBefore: current.validBefore,
      heldAt: current.heldAt,
    });
  } catch {
    const event = opts.ledger.proposeIndeterminate(
      holdId,
      "rpc_unavailable",
      checkedNow(opts.clock),
    );
    await opts.commit(event);
    return result(holdId, "indeterminate", event.reason);
  }

  const inspected = inspectStatus(status);
  if (!inspected) return persistMalformed(holdId, opts);

  if (inspected.state === "settled") {
    let event: Entry;
    try {
      event = opts.ledger.proposeSettled(
        holdId,
        status as Extract<PaymentStatus, { state: "settled" }>,
        checkedNow(opts.clock),
      );
    } catch {
      return persistMalformed(holdId, opts);
    }
    await opts.commit(event);
    return result(holdId, "settled", event.reason);
  }

  if (inspected.state === "unused_expired") {
    let event: Entry;
    try {
      event = opts.ledger.proposeReleasedUnused(
        holdId,
        status as Extract<PaymentStatus, { state: "unused_expired" }>,
        checkedNow(opts.clock),
      );
    } catch {
      return persistMalformed(holdId, opts);
    }
    await opts.commit(event);
    return result(holdId, "released", event.reason);
  }

  if (
    inspected.state !== "unknown" ||
    typeof inspected.reason !== "string" ||
    !CHAIN_UNKNOWN_REASONS.includes(
      inspected.reason as (typeof CHAIN_UNKNOWN_REASONS)[number],
    )
  ) {
    return persistMalformed(holdId, opts);
  }
  const event = opts.ledger.proposeIndeterminate(
    holdId,
    inspected.reason as (typeof CHAIN_UNKNOWN_REASONS)[number],
    checkedNow(opts.clock),
  );
  await opts.commit(event);
  return result(holdId, "indeterminate", event.reason);
}

async function persistMalformed(
  holdId: string,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const event = opts.ledger.proposeIndeterminate(
    holdId,
    "malformed_query",
    checkedNow(opts.clock),
  );
  await opts.commit(event);
  return result(holdId, "indeterminate", event.reason);
}

function inspectStatus(
  value: unknown,
): { readonly state: unknown; readonly reason: unknown } | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const state = Object.getOwnPropertyDescriptor(value, "state");
    if (!state || !("value" in state) || !state.enumerable) return undefined;
    const reason = Object.getOwnPropertyDescriptor(value, "reason");
    if (reason && (!("value" in reason) || !reason.enumerable)) return undefined;
    return { state: state.value, reason: reason?.value };
  } catch {
    return undefined;
  }
}

function result(
  holdId: string,
  outcome: ReconcileResult["outcome"],
  reason: string,
): ReconcileResult {
  return Object.freeze({ holdId, outcome, reason });
}

function hasAuthorization(entry: Entry): entry is Entry & {
  readonly nonce: string;
  readonly payer: string;
  readonly validBefore: bigint;
} {
  return (
    "nonce" in entry &&
    typeof entry.nonce === "string" &&
    "payer" in entry &&
    typeof entry.payer === "string" &&
    "validBefore" in entry &&
    typeof entry.validBefore === "bigint"
  );
}

function checkedNow(clock: Clock): number {
  const now = clock.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new LedgerError("clock returned an invalid unix-millisecond timestamp");
  }
  return now;
}

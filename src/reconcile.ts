/**
 * Reconciliation: when a payment goes quiet, go and look.
 *
 * This is the file that separates a guard from a guess.
 *
 * A hold that was placed but never resolved — the process crashed, the network
 * died, the facilitator never answered — is not an unknowable event. The payment
 * either settled on a public chain or it did not. Nobody in payments assumes;
 * they reconcile against the ledger. Ours happens to be a blockchain, which is
 * more authoritative than what a card network gets.
 *
 * This is also the direct answer to x402 issue #2821: "14 settled mainnet
 * payments not indexed after 9+ hours." The facilitator's index lost them. A
 * ledger that depends on the facilitator loses them too. Ours does not.
 *
 * Resolution, in order of evidence:
 *
 *   never signed                 -> release   (no payload could have gone out)
 *   chain: found                 -> settle    (record the transaction)
 *   chain: not found, past deadline -> release (unused and can no longer be used)
 *   chain: not found, still valid   -> flag    (a bearer authorization can still land)
 *   chain: cannot say            -> flag      (RPC down; a human resolves — never release)
 */

import { Ledger } from "./ledger.js";
import type { Entry } from "./ledger.js";
import type { ChainReader, Clock } from "./ports.js";

export interface ReconcileResult {
  holdId: string;
  outcome: "settled" | "released" | "indeterminate";
  detail: string;
}

export interface ReconcileOptions {
  ledger: Ledger;
  chain: ChainReader;
  clock: Clock;
  /** How long a hold may stay quiet before we go looking. */
  staleAfterMs: number;
  /** Called after each entry changes, so a durable store can append. */
  onEntry?: (entry: Entry) => Promise<void>;
}

/**
 * Sweep every hold that has gone quiet, and every hold left mid-lookup by a
 * previous crash. Safe to call repeatedly — on startup, on a timer, on demand.
 */
export async function sweep(opts: ReconcileOptions): Promise<ReconcileResult[]> {
  const { ledger, clock, staleAfterMs } = opts;
  const now = clock.now();

  const stale = ledger.staleHolds(now, staleAfterMs);
  const resuming = ledger.reconcilingHolds();
  // A transient RPC failure must not permanently strand a hold. Retry the ones
  // the chain could not answer for last time.
  const retrying = ledger.needsReconciliation();

  const results: ReconcileResult[] = [];

  for (const entry of [...stale, ...resuming, ...retrying]) {
    try {
      results.push(await reconcileOne(entry, opts));
    } catch (e) {
      // One hold that cannot be resolved must not abort the sweep for every
      // other hold in the batch. Record it and carry on.
      results.push({
        holdId: entry.holdId,
        outcome: "indeterminate",
        detail: `sweep failed for this hold: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return results;
}

async function reconcileOne(
  entry: Entry,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const { ledger, chain, clock, onEntry } = opts;
  const { holdId } = entry;

  // Persist the entry the mutator returned. Fishing `history().at(-1)` out
  // afterwards only works while no await sits between the mutation and the read
  // — an invariant nothing enforces and one refactor from a silent mis-persist.
  const emit = async (e: Entry) => {
    if (onEntry) await onEntry(e);
  };

  // Re-read the hold's CURRENT state, not the snapshot the sweep captured
  // before its per-entry awaits. The identical TOCTOU that `guard.authorize`
  // closes: while this sweep blocks on an RPC for one hold, the agent can
  // finish signing another hold's payload and call attachAuthorization. Acting
  // on the frozen snapshot would then release a hold whose nonce was attached
  // during the await — freeing budget for a payment in flight.
  const current = ledger.state(holdId);
  if (!current || current.status === "settled" || current.status === "released") {
    return { holdId, outcome: current?.status === "settled" ? "settled" : "released",
             detail: "already resolved by the time the sweep reached it" };
  }

  // A hold with no recorded nonce is NOT provably unsigned. attachAuthorization
  // runs after the payload is signed, so a crash in the sign→attach window
  // leaves exactly this state — a live bearer authorization the facilitator can
  // still submit, with nothing in the ledger to look up. Releasing here (as an
  // earlier version did, claiming "no payload could have gone out") frees budget
  // for a payment that can still land: the double-spend.
  //
  // We cannot ask the chain (no nonce to query), and we cannot prove it was
  // never signed. So it flags for a human. The caller that KNOWS it never signed
  // releases it explicitly via Guard.abandon().
  if (!current.nonce || !current.payer) {
    const detail =
      "held with no recorded authorization; a payload may have been signed before " +
      "attach (crash in the sign→attach window). Cannot prove no money moved — a " +
      "human resolves, or the caller abandons it if it was never signed.";
    await emit(ledger.flag(holdId, detail));
    return { holdId, outcome: "indeterminate", detail };
  }

  // Move it into 'reconciling' before the lookup, so a crash mid-lookup is
  // recoverable: the next sweep resumes it rather than treating it as fresh.
  if (current.status === "held" || current.status === "indeterminate") {
    await emit(ledger.reconciling(holdId, "asking the chain"));
  }

  let status;
  try {
    status = await chain.findPayment({
      quote: current.quote,
      nonce: current.nonce,
      payer: current.payer,
      // Without this the reader searches a fixed window back from the chain
      // head, misses an older settlement, reports "not found", and the hold is
      // released — handing back budget for money that already left.
      heldAt: current.at,
    });
  } catch (e) {
    // An RPC that throws is an RPC that cannot answer. It is NOT evidence that
    // the payment did not happen.
    const detail = `chain lookup failed: ${e instanceof Error ? e.message : String(e)}`;
    await emit(ledger.flag(holdId, detail));
    return { holdId, outcome: "indeterminate", detail };
  }

  if (status.found === true) {
    const detail = `chain confirms settlement in ${status.transaction}`;
    await emit(ledger.confirm(holdId, status.transaction));
    return { holdId, outcome: "settled", detail };
  }

  if (status.found === false) {
    // The chain says the authorization has not been used — but a signed EIP-3009
    // authorization is a bearer instrument the facilitator can still submit up
    // to `validBefore`. "Not used yet" only becomes "never used" once that
    // deadline passes and the transfer would revert on-chain. Releasing before
    // then frees budget the agent respends while the original is still landable.
    const deadline = current.validBefore;
    if (deadline !== undefined && clock.now() <= deadline) {
      const detail =
        `chain shows the authorization unused, but it remains submittable until ` +
        `${new Date(deadline).toISOString()}. Holding until then; not releasing on a ` +
        `payment that can still land.`;
      await emit(ledger.flag(holdId, detail));
      return { holdId, outcome: "indeterminate", detail };
    }

    // Past the deadline (or a hold that never carried an authorization): the
    // money did not move and cannot now. This is the only safe release, and it
    // is safe because it is evidence, not silence.
    const detail = "chain confirms the authorization was never used and can no longer be; releasing the hold";
    await emit(ledger.release(holdId, detail));
    return { holdId, outcome: "released", detail };
  }

  // "unknown" — the chain could not say. This is the genuine last resort, and
  // the hold stays committed. Handing budget back for money that may already
  // have left is how an agent double-spends.
  const detail = `chain could not answer: ${status.reason}`;
  await emit(ledger.flag(holdId, detail));
  return { holdId, outcome: "indeterminate", detail };
}

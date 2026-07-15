/**
 * Ports: what the core needs from the outside world, stated as interfaces.
 *
 * The core's correctness comes from having no I/O — no clock, no network, no
 * disk. Reconciliation and durability need all three. So the core declares what
 * it needs and never learns who provides it. The dirty implementations live at
 * the edges and are swapped for fakes in tests.
 *
 * This is the seam that keeps `evaluate()` a pure function you can reason about
 * while the thing around it talks to a blockchain.
 */

import type { Entry } from "./ledger.js";
import type { Quote } from "./policy.js";

/** Time, injected. A gate that reads the wall clock cannot be tested at its boundaries. */
export interface Clock {
  /** Unix ms. */
  now(): number;
}

/**
 * Durable, append-only storage for ledger entries.
 *
 * `append` must reach the disk BEFORE the payment it describes goes out. A hold
 * that exists only in memory is a hold that a crash erases — and an erased hold
 * is budget the agent can spend twice.
 */
export interface LedgerStore {
  append(entry: Entry): Promise<void>;
  /** Every entry ever written, oldest first. Used to rebuild state on startup. */
  readAll(): Promise<Entry[]>;
}

/** What the chain says about a payment we lost track of. */
export type PaymentStatus =
  | { found: true; transaction: string }
  /** The chain is definitive: this authorization was never used. Safe to release. */
  | { found: false }
  /**
   * The chain could not answer — RPC down, results ambiguous, we could not look
   * far enough back, or the settlement did not match the authorized quote.
   *
   * NOT the same as "not found". Never release on this; a human reconciles.
   */
  | { found: "unknown"; reason: string };

/**
 * Reads settlement truth from the chain.
 *
 * This exists because the alternative is guessing. When a payment goes missing,
 * a payments operator does not assume — they reconcile against the ledger. Ours
 * is public.
 *
 * TWO things must be checked, and checking only the first is a hole big enough
 * to drive a budget through:
 *
 * 1. WAS an authorization used?  Matched on the EIP-3009 nonce, which is unique
 *    per authorization. Amount+payee alone would be ambiguous the moment an
 *    agent pays the same seller the same amount twice.
 *
 * 2. WAS IT THE ONE WE AUTHORIZED?  The `AuthorizationUsed` event carries no
 *    value and no recipient. So an implementation that stops at (1) confirms
 *    that *something* was paid, records the quote it *expected*, and cites a
 *    real transaction hash as proof — while the money actually went somewhere
 *    else, in a different amount. The ledger would assert a lie and attach a
 *    receipt to it. The settlement's ERC-20 `Transfer(from, to, value)` log
 *    must be checked against the quote.
 */
export interface ChainReader {
  findPayment(params: {
    /** The quote the guard authorized. The settlement must match it. */
    quote: Quote;
    /** The EIP-3009 authorization nonce, captured at payload creation. */
    nonce: string;
    /** Payer address — the authorization's `from`. */
    payer: string;
    /**
     * When the hold was placed (unix ms).
     *
     * The lookup must cover the whole interval from here to now. Without it, a
     * reader searching a fixed window back from the chain head will fail to see
     * an older settlement, report "not found", and cause the hold to be
     * released — handing back budget for money that already left.
     */
    heldAt: number;
  }): Promise<PaymentStatus>;
}

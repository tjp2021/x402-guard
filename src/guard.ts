/**
 * The Guard: the composition root, and the only correct way to use this library.
 *
 * Everything else in `src/` is a primitive. This is the file where they are
 * assembled in the one order that makes the safety claims true, and it exists
 * because leaving that assembly to the caller was the library's biggest hole:
 *
 *   - `evaluate()` decides. `Ledger.hold()` reserves. If a caller does the
 *     natural thing —
 *
 *         const [a, b] = await Promise.all([gate(q), gate(q)]);
 *
 *     — both evaluate against the same remaining balance, both are allowed, and
 *     the budget is breached by the tool whose entire purpose is preventing that.
 *     `authorize()` closes the window by doing evaluate-and-hold in a single
 *     synchronous critical section, before any await can interleave.
 *
 *   - A hold that exists only in memory is a hold a crash erases, and an erased
 *     hold is budget the agent spends twice. `authorize()` persists the hold and
 *     awaits the write BEFORE returning an ALLOW the caller may act on.
 *
 * Node runs one turn of the event loop at a time, so the evaluate→hold sequence
 * below cannot be interleaved: there is no `await` between the two. That is the
 * whole mechanism, and it is why the ordering in this file is load-bearing
 * rather than stylistic.
 */

import { evaluate, quoteHash } from "./evaluate.js";
import { Ledger } from "./ledger.js";
import type { Entry } from "./ledger.js";
import type { Policy, Quote, Verdict } from "./policy.js";
import type { Clock, LedgerStore, ChainReader } from "./ports.js";
import { sweep, type ReconcileResult } from "./reconcile.js";

export interface GuardOptions {
  policy: Policy;
  policyHash: string;
  store: LedgerStore;
  chain: ChainReader;
  clock: Clock;
  /** How long a hold may stay quiet before the sweep asks the chain. */
  staleAfterMs?: number;
  /** How long a human approval stays valid once granted. Default 10 min. */
  approvalTtlMs?: number;
}

/** An ALLOW carries the hold that reserved the budget for it. */
export type Authorization =
  | { verdict: Verdict; decision: "allow"; holdId: string }
  | { verdict: Verdict; decision: "deny" | "require_approval"; holdId?: undefined };

export class Guard {
  /** Granted approvals, by quote hash. In-memory: an approval is short-lived. */
  private readonly approvals = new Map<string, number>();

  private constructor(
    private readonly ledger: Ledger,
    private readonly opts: Required<Pick<GuardOptions, "staleAfterMs" | "approvalTtlMs">> &
      GuardOptions,
  ) {}

  /** Rebuild from the durable log, then reconcile anything the last run left open. */
  static async open(opts: GuardOptions): Promise<Guard> {
    const ledger = Ledger.restore(await opts.store.readAll());
    const guard = new Guard(ledger, {
      staleAfterMs: 10 * 60 * 1000,
      approvalTtlMs: 10 * 60 * 1000,
      ...opts,
    });
    await guard.reconcile();
    return guard;
  }

  /**
   * A human approves a payment that hit the approval tier.
   *
   * The approval binds to this exact quote and expires. It is single-use: it is
   * consumed the moment an authorize() spends it, so one "yes" authorizes one
   * payment and cannot be replayed for a second.
   */
  approve(quote: Quote): void {
    this.approvals.set(quoteHash(quote), this.opts.clock.now() + this.opts.approvalTtlMs);
  }

  /**
   * Decide, and reserve the budget in the same breath.
   *
   * On ALLOW the hold is placed and durably written before this resolves, so a
   * concurrent call sees the reduced balance and a crash cannot lose it. The
   * caller may pay only after this returns.
   */
  async authorize(quote: Quote): Promise<Authorization> {
    const { policy, policyHash, clock, store } = this.opts;
    const now = clock.now();
    const qh = quoteHash(quote);
    const expiresAt = this.approvals.get(qh);
    const approval = expiresAt !== undefined ? { quoteHash: qh, expiresAt } : undefined;

    // --- critical section: no await, so nothing can interleave --------------
    const verdict = evaluate({
      policy,
      quote,
      committed: this.ledger.committed(policy, now),
      paymentsLastHour: this.ledger.paymentsLastHour(now),
      policyHash,
      now,
      ...(approval ? { approval } : {}),
    });

    if (verdict.decision !== "allow") {
      return { verdict, decision: verdict.decision };
    }

    // An approval satisfied its purpose the instant it produced an ALLOW.
    // Consuming it here — inside the same synchronous section, before any await
    // — makes it single-use: a replayed authorize() for the same quote finds no
    // approval and returns require_approval again.
    this.approvals.delete(qh);

    const entry = this.ledger.hold(quote, now);
    // --- end critical section -----------------------------------------------

    // The hold is already visible to any concurrent authorize() above. Now make
    // it survive a crash, before the caller is told it may spend.
    await store.append(entry);

    return { verdict, decision: "allow", holdId: entry.holdId };
  }

  /**
   * The payload was signed. Bind its authorization to the hold.
   *
   * `validBefore` is the EIP-3009 deadline until which the facilitator may still
   * submit it. The reconciler needs it to know when "not on chain yet" becomes
   * "never will be" — releasing before then double-spends the budget.
   */
  async attachAuthorization(
    holdId: string,
    nonce: string,
    payer: string,
    validBefore: number,
  ): Promise<void> {
    await this.opts.store.append(
      this.ledger.attachAuthorization(holdId, nonce, payer, validBefore),
    );
  }

  /** The payment settled. */
  async confirm(holdId: string, transaction: string): Promise<void> {
    await this.opts.store.append(this.ledger.confirm(holdId, transaction));
  }

  /** The payment definitively did not happen. Never call this on silence. */
  async release(holdId: string, note: string): Promise<void> {
    await this.opts.store.append(this.ledger.release(holdId, note));
  }

  /**
   * Affirm that no payload was ever signed for this hold, releasing its budget.
   *
   * The only safe release for a hold that never reached attachAuthorization —
   * the caller is the one party that knows it never signed. Refused once a nonce
   * is attached: then a payload exists and only the chain can resolve it.
   */
  async abandon(holdId: string, note: string): Promise<void> {
    await this.opts.store.append(this.ledger.abandon(holdId, note));
  }

  /** Ask the chain about anything that went quiet. Safe to call on a timer. */
  async reconcile(): Promise<ReconcileResult[]> {
    const { chain, clock, staleAfterMs, store } = this.opts;
    return sweep({
      ledger: this.ledger,
      chain,
      clock,
      staleAfterMs,
      onEntry: (e: Entry) => store.append(e),
    });
  }

  /** Holds the chain could not resolve. A human must look at these. */
  needsReconciliation(): readonly Entry[] {
    return this.ledger.needsReconciliation();
  }

  /** The audit trail. */
  history(): readonly Entry[] {
    return this.ledger.history();
  }
}

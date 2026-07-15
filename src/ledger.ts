/**
 * The ledger: append-only spend record with authorization holds.
 *
 * Why holds exist (LOG.md 2026-07-14, adversarial finding 2):
 *
 * Check-then-pay is not atomic. An agent with $0.90 of budget left fires two
 * $0.80 payments concurrently. Both evaluate against the same remaining
 * balance. Both are allowed. Both settle. The budget is breached — by the tool
 * whose entire purpose is preventing exactly that.
 *
 * Card networks solved this decades ago and the answer is an authorization
 * hold: reserve the funds when you authorize, reconcile when you settle. The
 * gate reserves at ALLOW; the caller then reports what actually happened.
 *
 *   allow    -> hold(quote)       committed += amount
 *   settled  -> confirm(holdId)   hold becomes spend; committed unchanged
 *   aborted  -> release(holdId)   committed -= amount
 *   unknown  -> flag(holdId)      committed unchanged; needs a human
 *
 * An indeterminate outcome is NEVER auto-released. Releasing a hold on a
 * payment that might have settled is how you double-spend a budget. A hold that
 * cannot be resolved stays committed and surfaces for manual reconciliation —
 * the balance is wrong in the safe direction.
 *
 * The entry log is append-only. Entries are never mutated or deleted; state
 * changes are new entries. History is the evidence.
 */

import type { Atomic } from "./amount.js";
import type { Policy, Quote, BudgetWindow } from "./policy.js";

export type HoldStatus =
  | "held"
  | "settled"
  | "released"
  /** Lost track of it; going to ask the chain. Still consumes budget. */
  | "reconciling"
  /** The chain could not answer either. A human must resolve. Still consumes budget. */
  | "indeterminate";

export interface Entry {
  holdId: string;
  quote: Quote;
  amount: Atomic;
  /** Unix ms — when the hold was placed. Windows are measured against this. */
  at: number;
  status: HoldStatus;
  /** Set when settled: the on-chain transaction reference. */
  transaction?: string;
  /**
   * The EIP-3009 authorization nonce, attached once the payload is signed.
   *
   * Without it, reconciliation is guesswork: an agent that pays the same seller
   * the same amount twice cannot be matched against the chain by amount+payee
   * alone. The nonce is the only unambiguous key.
   */
  nonce?: string;
  /** The payer address from the authorization. Needed to query the chain. */
  payer?: string;
  /**
   * The EIP-3009 `validBefore`, unix ms. The deadline until which a facilitator
   * may still submit the signed authorization on-chain.
   *
   * This is the field whose absence made the whole release rule unsound. An
   * authorization is a signed bearer instrument: "not on chain yet" does NOT
   * mean "never will be". A facilitator can sit on the payload — which is
   * exactly x402 issue #2821, a 9+ hour delay — and submit it at the last
   * second. Releasing a hold before `validBefore` frees budget the agent can
   * respend, and then the facilitator settles the original. Both land.
   *
   * So a nonce-carrying hold whose chain lookup says "not used" may only be
   * released once `now > validBefore`, because only then does the transfer
   * revert on-chain and "not used" become permanent.
   */
  validBefore?: number;
  /** Set when released, reconciling, or flagged: why. */
  note?: string;
}

export class LedgerError extends Error {}

const WINDOW_MS: Record<BudgetWindow, number> = {
  "rolling-1h": 60 * 60 * 1000,
  "rolling-24h": 24 * 60 * 60 * 1000,
};

/** Statuses a hold can still be resolved from. `settled` and `released` are terminal. */
const RESOLVABLE: ReadonlySet<HoldStatus> = new Set<HoldStatus>([
  "held",
  "reconciling",
  // 'indeterminate' is resolvable — by a human, or by a later sweep once the RPC
  // recovers. Making it terminal would let one transient network blip convert a
  // hold into a zombie that consumes budget until its window ages out, with no
  // path back. Fail-safe is the right direction; a fail-safe with no exit is not.
  "indeterminate",
]);

/**
 * In-memory, append-only. Correctness of the hold lifecycle is this file's job;
 * durability belongs to a LedgerStore, and composition belongs to the Guard.
 *
 * SINGLE WRITER ONLY. Two processes sharing one ledger file each hold their own
 * in-memory view, each enforce the full cap independently, and together spend
 * twice the budget. Nothing here locks, and no ID scheme survives two writers —
 * `idPrefix` makes collisions detectable, not impossible. If you need multiple
 * agents, give each its own ledger and its own budget, or put a real store
 * behind this interface.
 *
 * Honest limitation, repeated in the threat model: this is in-process state. An
 * agent that can write to the host can tamper with it. x402-guard is a seatbelt,
 * not a cage — pair it with onchain spend permissions for hard enforcement.
 */
export class Ledger {
  private readonly entries: Entry[] = [];
  private seq = 0;

  /**
   * Namespaces hold ids. Two ledgers writing one file would otherwise both mint
   * `hold-1`, and `current()` folds by id with later entries winning — so two
   * distinct payments would collapse into one and the budget would under-count
   * by a whole payment. Distinct prefixes turn that silent corruption into a
   * visible one.
   */
  constructor(private readonly idPrefix: string = "hold") {}

  /** Every entry, oldest first. Callers must not mutate the result. */
  history(): readonly Entry[] {
    return this.entries;
  }

  /**
   * Amount counted against budgets: settled spend PLUS outstanding holds.
   *
   * Counting holds is the point. A hold is money the agent has been authorized
   * to spend and may already be spending; a budget that ignores it is a budget
   * that can be raced.
   */
  committed(policy: Policy, now: number): Map<string, Atomic> {
    const out = new Map<string, Atomic>();
    for (const budget of policy.budgets) {
      const since = now - WINDOW_MS[budget.window];
      let total = 0n;
      // Fold over CURRENT state per hold, not over raw entries. The log is
      // append-only, so a settled hold has both a 'held' and a 'settled' entry;
      // summing entries would count the same money twice.
      for (const e of this.current()) {
        if (e.at < since) continue;
        // 'held' and 'settled' both consume budget. 'released' does not — the
        // money never moved. 'indeterminate' DOES: we cannot prove it didn't.
        if (e.status === "released") continue;
        total += e.amount;
      }
      out.set(budget.name, total);
    }
    return out;
  }

  /** Payments in the trailing hour, for the velocity clause. Excludes releases. */
  paymentsLastHour(now: number): number {
    const since = now - WINDOW_MS["rolling-1h"];
    return this.current().filter((e) => e.at >= since && e.status !== "released")
      .length;
  }

  /** Current state of every hold, one entry each, oldest first. */
  private current(): Entry[] {
    const byHold = new Map<string, Entry>();
    for (const e of this.entries) byHold.set(e.holdId, e); // later entries win
    return [...byHold.values()];
  }

  /**
   * Reserve budget for an authorized quote. Called on ALLOW, before payment.
   *
   * This is the atomic step: once a hold exists, a concurrent evaluation sees
   * the reduced remaining balance and cannot be allowed against the same funds.
   */
  hold(quote: Quote, now: number): Entry {
    const holdId = `${this.idPrefix}-${++this.seq}`;
    return this.push({
      holdId,
      quote,
      amount: quote.amount,
      at: now,
      status: "held",
    });
  }

  /** The single append point. Returns the entry it wrote, so a caller
   *  persisting it cannot mis-target by fishing the newest entry out later. */
  private push(entry: Entry): Entry {
    this.entries.push(entry);
    return entry;
  }

  /**
   * Attach the EIP-3009 authorization nonce, once the payload is signed.
   *
   * The hold is placed BEFORE signing (budget must be reserved before money can
   * move), so the nonce does not exist yet at hold time. Without capturing it
   * here, an orphaned hold cannot be matched against the chain unambiguously.
   */
  attachAuthorization(
    holdId: string,
    nonce: string,
    payer: string,
    validBefore: number,
  ): Entry {
    const e = this.require(holdId);
    if (e.status !== "held") {
      throw new LedgerError(`hold ${holdId} is ${e.status}, cannot attach authorization`);
    }
    // Single-use, and this guard is load-bearing. Without it: sign a real
    // authorization, broadcast it, then attach a fresh UNUSED nonce. The sweep
    // queries the second nonce, the chain truthfully answers "never used", and
    // the hold is released. The chain told the truth; we asked the wrong
    // question. The status guard above does not catch this, because attaching
    // leaves the hold in 'held'.
    if (e.nonce !== undefined) {
      throw new LedgerError(
        `hold ${holdId} already carries authorization ${e.nonce}; refusing to overwrite it`,
      );
    }
    return this.push({ ...e, nonce, payer, validBefore, at: e.at });
  }

  /**
   * The caller affirms no payload was ever signed for this hold, so it is safe
   * to release the budget.
   *
   * This is the ONLY safe release for a hold that carries no nonce. The
   * reconciler cannot make it: "no nonce recorded" does not mean "no payload
   * signed" — attachAuthorization runs AFTER signing, so a crash in the
   * sign→attach window leaves a live bearer authorization with no ledger record.
   * Only the caller knows it never signed, so only the caller may release it.
   *
   * A hold that already carries a nonce is refused: a payload exists, and it can
   * only be resolved by reconciling against the chain.
   */
  abandon(holdId: string, note: string): Entry {
    const e = this.require(holdId);
    if (e.status !== "held" && e.status !== "indeterminate") {
      throw new LedgerError(`hold ${holdId} is ${e.status}, cannot abandon`);
    }
    if (e.nonce !== undefined) {
      throw new LedgerError(
        `hold ${holdId} carries authorization ${e.nonce}; a payload was signed and ` +
          `may still land — reconcile against the chain, do not abandon`,
      );
    }
    return this.push({ ...e, status: "released", note, at: e.at });
  }

  /** The payment settled. The hold becomes real spend. */
  confirm(holdId: string, transaction: string): Entry {
    const e = this.require(holdId);
    if (!RESOLVABLE.has(e.status)) {
      throw new LedgerError(`hold ${holdId} is ${e.status}, cannot confirm`);
    }
    return this.push({ ...e, status: "settled", transaction, at: e.at });
  }

  /**
   * The payment definitively did not happen. Give the budget back.
   *
   * "Definitively" is load-bearing. Release on a known abort, or on a chain
   * lookup that proves the authorization was never used. NEVER on silence.
   */
  release(holdId: string, note: string): Entry {
    const e = this.require(holdId);
    if (!RESOLVABLE.has(e.status)) {
      throw new LedgerError(`hold ${holdId} is ${e.status}, cannot release`);
    }
    return this.push({ ...e, status: "released", note, at: e.at });
  }

  /**
   * We lost track of this payment. Mark it for a chain lookup.
   *
   * The budget stays consumed while we find out. Silence is not evidence of
   * anything, and an agent must not be handed back money that may already
   * have left.
   */
  reconciling(holdId: string, note: string): Entry {
    const e = this.require(holdId);
    if (e.status !== "held" && e.status !== "indeterminate") {
      throw new LedgerError(`hold ${holdId} is ${e.status}, cannot reconcile`);
    }
    return this.push({ ...e, status: "reconciling", note, at: e.at });
  }

  /**
   * Holds that have gone quiet past the timeout and need a chain lookup.
   *
   * A hold with no authorization nonce cannot be looked up (the payload was
   * never signed, so no payment could have been broadcast) — those are safe to
   * release, and the sweep caller does so.
   */
  staleHolds(now: number, timeoutMs: number): readonly Entry[] {
    return this.current().filter(
      (e) => e.status === "held" && now - e.at >= timeoutMs,
    );
  }

  /** Holds mid-lookup. Rebuilt on startup; the sweep resumes them. */
  reconcilingHolds(): readonly Entry[] {
    return this.current().filter((e) => e.status === "reconciling");
  }

  /**
   * The last resort: the chain could not answer either.
   *
   * RPC unreachable, results ambiguous. NOT the response to silence — silence
   * triggers a lookup, and only a failed lookup lands here.
   *
   * The hold STAYS committed. Releasing it would risk handing back budget for
   * money that actually left. Wrong in the safe direction, and visible.
   */
  flag(holdId: string, note: string): Entry {
    const e = this.require(holdId);
    if (!RESOLVABLE.has(e.status)) {
      throw new LedgerError(`hold ${holdId} is ${e.status}, cannot flag`);
    }
    return this.push({ ...e, status: "indeterminate", note, at: e.at });
  }

  /** Holds that need a human. Never silently resolved. */
  needsReconciliation(): readonly Entry[] {
    return this.current().filter((e) => e.status === "indeterminate");
  }

  /** Rebuild in-memory state from a durable log. Called on startup. */
  static restore(entries: readonly Entry[], idPrefix = "hold"): Ledger {
    const l = new Ledger(idPrefix);
    for (const e of entries) {
      l.entries.push(e);
      // Keep the id counter ahead of anything already issued, or a new hold
      // would reuse an id and silently overwrite a prior hold's state.
      const n = Number(e.holdId.slice(e.holdId.lastIndexOf("-") + 1));
      if (Number.isInteger(n) && n > l.seq) l.seq = n;
    }
    return l;
  }

  /** The current state of a hold — the newest entry wins; history is preserved.
   *  Public so the reconciler can re-read a hold after an await instead of
   *  trusting a stale snapshot. */
  state(holdId: string): Entry | undefined {
    return this.latest(holdId);
  }

  private latest(holdId: string): Entry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.holdId === holdId) return e;
    }
    return undefined;
  }

  private require(holdId: string): Entry {
    const e = this.latest(holdId);
    if (!e) throw new LedgerError(`unknown hold ${holdId}`);
    return e;
  }
}

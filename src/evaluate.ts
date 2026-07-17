/**
 * The gate. Evaluates a quote against a policy, given the budget state.
 *
 * Pure: no clock, no network, no I/O. `now` and the ledger's committed spend
 * are passed in. A gate that reads the wall clock cannot be tested against the
 * boundary conditions that matter, and a gate that reads the network cannot be
 * trusted to fail closed.
 *
 * Resolution (never short-circuits — every clause is evaluated):
 *   any deny        -> deny
 *   else any trip   -> require_approval
 *   else            -> allow
 */

import type {
  Policy,
  Quote,
  Verdict,
  BudgetState,
  Reason,
} from "./policy.js";
import { createHash } from "node:crypto";
import { formatAmount } from "./amount.js";
import type { Atomic } from "./amount.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Settled spend + outstanding holds, per budget name. Supplied by the ledger. */
export type CommittedByBudget = ReadonlyMap<string, Atomic>;

export interface EvaluateInput {
  policy: Policy;
  quote: Quote;
  /** Cumulative committed spend per budget, within each budget's window. */
  committed: CommittedByBudget;
  /** Payments already made in the trailing hour, for the velocity clause. */
  paymentsLastHour: number;
  policyHash: string;
  /** Unix ms. Injected, never read from the clock. */
  now: number;
  /**
   * An in-process caller approval assertion for THIS quote, if any. When
   * present and valid, it satisfies the advisory approval tier — the payment is
   * allowed rather than sent back for approval again. This does not prove that
   * an independent human or external authority approved the payment.
   *
   * Without this, an approval-tier verdict is a dead end: it repeats forever,
   * so the only way to pay is to bypass the guard, which puts the money outside
   * the ledger. The approval must be bound to this exact quote and unexpired;
   * an approval for a different quote, or a stale one, does not apply.
   */
  approval?: { quoteHash: string; expiresAt: number };
}

interface Finding {
  decision: "deny" | "require_approval";
  reason: Reason;
  clause: string;
  detail: string;
}

/** A hard deny for a malformed quote, before any budget math touches it. */
function deny(
  input: EvaluateInput,
  reason: Reason,
  clause: string,
  detail: string,
): Verdict {
  return {
    decision: "deny",
    reason,
    clause,
    detail,
    budgets: [],
    quote: input.quote,
    policyHash: input.policyHash,
    at: input.now,
  };
}

/**
 * A stable identity for a quote, so an approval can be bound to exactly one.
 *
 * The fields that define what is being paid: amount, asset, network, payee, and
 * the resource. Two quotes with the same five are the same payment for approval
 * purposes; change any one and a prior approval no longer applies.
 */
export function quoteHash(quote: Quote): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        quote.amount.toString(),
        quote.asset.toLowerCase(),
        quote.network,
        quote.payTo.toLowerCase(),
        quote.resource,
      ]),
    )
    .digest("hex");
  return `sha256:${digest}`;
}

export function evaluate(input: EvaluateInput): Verdict {
  const { policy, quote, committed, paymentsLastHour, policyHash, now } = input;
  const d = policy.asset.decimals;
  const fmt = (a: Atomic) => formatAmount(a, d);

  // The quote is the ONE untrusted input in the system — it comes from a
  // hostile seller's 402 challenge. Validate it before any comparison. A
  // negative amount passes every `>` limit check, holds negative budget, and
  // MINTS spending power; a malformed address defeats the allowlist. The policy
  // loader validates its input with paranoid rigor — the boundary that faces
  // the attacker cannot be the one boundary that trusts.
  if (quote.amount < 0n) {
    return deny(input, "amount_exceeds_max", "quote.amount",
      `quote amount ${quote.amount} is negative`);
  }
  if (!ADDRESS.test(quote.payTo)) {
    return deny(input, "payee_not_allowed", "quote.payTo",
      `quote payTo ${quote.payTo} is not a valid address`);
  }
  if (!ADDRESS.test(quote.asset)) {
    return deny(input, "asset_mismatch", "quote.asset",
      `quote asset ${quote.asset} is not a valid address`);
  }

  // Budget state is computed for every verdict, not just budget denials. A
  // verdict is evidence; "how close was it?" is part of the evidence.
  const budgets: BudgetState[] = policy.budgets.map((b) => {
    const spent = committed.get(b.name) ?? 0n;
    const projected = spent + quote.amount;
    return {
      name: b.name,
      window: b.window,
      limit: b.limit,
      committed: spent,
      remaining: b.limit > projected ? b.limit - projected : 0n,
    };
  });

  const findings: Finding[] = [];

  // --- Deny clauses -------------------------------------------------------
  // Asset and network are pinned. An unpinned guard would happily authorize a
  // payment on mainnet, in a different token, against a testnet policy.

  if (quote.asset.toLowerCase() !== policy.asset.address.toLowerCase()) {
    findings.push({
      decision: "deny",
      reason: "asset_mismatch",
      clause: "asset.address",
      detail: `quote asset ${quote.asset} is not the policy asset ${policy.asset.address}`,
    });
  }

  if (quote.network !== policy.asset.network) {
    findings.push({
      decision: "deny",
      reason: "network_mismatch",
      clause: "asset.network",
      detail: `quote network ${quote.network} is not the policy network ${policy.asset.network}`,
    });
  }

  if (now >= policy.mandate.expires) {
    findings.push({
      decision: "deny",
      reason: "mandate_expired",
      clause: "mandate.expires",
      detail: `mandate expired at ${new Date(policy.mandate.expires).toISOString()}`,
    });
  }

  const payee = policy.payees.find(
    (p) => p.address.toLowerCase() === quote.payTo.toLowerCase(),
  );
  if (!payee) {
    findings.push({
      decision: "deny",
      reason: "payee_not_allowed",
      clause: "payees",
      detail: `${quote.payTo} is not an allowlisted payee`,
    });
  }

  if (quote.amount > policy.payments.maxPerPayment) {
    findings.push({
      decision: "deny",
      reason: "amount_exceeds_max",
      clause: "payments.max_per_payment",
      detail: `${fmt(quote.amount)} exceeds the per-payment cap of ${fmt(policy.payments.maxPerPayment)}`,
    });
  }

  // The clause a bare per-attempt SDK hook does not supply: an agent
  // that splits an over-budget purchase into two under-limit charges passes
  // every per-payment check and still breaches the budget.
  for (const b of budgets) {
    const projected = b.committed + quote.amount;
    if (projected > b.limit) {
      findings.push({
        decision: "deny",
        reason: "budget_exceeded",
        clause: `budgets.${b.name}`,
        detail:
          `${fmt(quote.amount)} would raise ${b.window} spend to ${fmt(projected)} ` +
          `of the ${fmt(b.limit)} limit (${fmt(b.committed)} already committed)`,
      });
    }
  }

  if (paymentsLastHour >= policy.velocity.maxPaymentsPerHour) {
    findings.push({
      decision: "deny",
      reason: "velocity_exceeded",
      clause: "velocity.max_payments_per_hour",
      detail: `${paymentsLastHour} payments in the trailing hour meets the cap of ${policy.velocity.maxPaymentsPerHour}`,
    });
  }

  // --- Approval clause ----------------------------------------------------
  // At or above the threshold the caller must explicitly attest approval —
  // UNLESS a valid assertion for this exact quote is already in hand. An
  // assertion bound to a different quote, or one that has expired, does not
  // apply: it is one assertion for one payment, which stops a single "yes"
  // being replayed. Independent human proof requires an external verifier.

  if (quote.amount >= policy.payments.requireApprovalOver) {
    const a = input.approval;
    const satisfied =
      a !== undefined && a.quoteHash === quoteHash(quote) && now < a.expiresAt;
    if (!satisfied) {
      findings.push({
        decision: "require_approval",
        reason: "approval_required",
        clause: "payments.require_approval_over",
        detail: `${fmt(quote.amount)} is at or above the approval threshold of ${fmt(policy.payments.requireApprovalOver)}`,
      });
    }
  }

  // --- Resolution: deny wins, then approval, then allow -------------------

  const decided =
    findings.find((f) => f.decision === "deny") ??
    findings.find((f) => f.decision === "require_approval");

  const base = { budgets, quote, policyHash, at: now };

  if (decided) {
    return { ...base, ...decided };
  }

  return {
    ...base,
    decision: "allow",
    reason: "within_policy",
    clause: "payees",
    detail: `payee ${payee?.name ?? quote.payTo} is allowlisted and all limits pass`,
  };
}

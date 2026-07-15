/**
 * The policy document, and the verdict it produces.
 *
 * Design constraints, each earned from prior art (see LOG.md 2026-07-14):
 *
 * - No expression language. Fixed keys, typed values. Rego and XACML both died
 *   of unreadability; if a finance owner cannot read the policy, we have
 *   rebuilt XACML in JSON.
 * - Deny always wins, and evaluation never short-circuits on the first match.
 *   Stripe Radar's first-match-wins lets a broad Allow bypass every Block rule.
 * - Budgets are a first-class noun, not something you compute in a callback.
 *   This is the whole gap: x402's own hook is stateless, so it cannot see that
 *   two under-limit payments add up to an over-limit one.
 * - Every verdict names the clause that decided it. XACML's most-cited
 *   operational failure was that a denial could not tell you why.
 */

import type { Atomic } from "./amount.js";

/** A payment quote, normalized from an x402 402 challenge. */
export interface Quote {
  /** Atomic units, as x402 quotes them. */
  amount: Atomic;
  /** Token contract address. */
  asset: string;
  /** CAIP-2 network id, e.g. "eip155:84532" (Base Sepolia). */
  network: string;
  /** Recipient address. */
  payTo: string;
  /** The resource being paid for. */
  resource: string;
}

export interface Payee {
  name: string;
  address: string;
}

export type BudgetWindow = "rolling-24h" | "rolling-1h";

export interface Budget {
  name: string;
  window: BudgetWindow;
  /** Cumulative cap across every payment in the window. */
  limit: Atomic;
}

/**
 * A parsed, validated policy. Amounts are already atomic; the loader does all
 * decimal parsing so the evaluator never sees a string.
 */
export interface Policy {
  name: string;
  version: number;
  asset: {
    symbol: string;
    /** Quotes on any other asset are denied — including mainnet addresses. */
    address: string;
    /** Quotes on any other network are denied — including mainnet. */
    network: string;
    decimals: number;
  };
  mandate: {
    holder: string;
    agent: string;
    /** Unix ms. A quote after this is denied. */
    expires: number;
  };
  /** Allowlist. An unlisted payee is denied — default-deny, confirmed 2026-07-14. */
  payees: Payee[];
  payments: {
    maxPerPayment: Atomic;
    /** At or above this, a human must approve. */
    requireApprovalOver: Atomic;
  };
  budgets: Budget[];
  velocity: {
    maxPaymentsPerHour: number;
  };
}

export type Decision = "allow" | "deny" | "require_approval";

/** Machine-readable reasons. A caller must never string-match an Error message. */
export type Reason =
  | "asset_mismatch"
  | "network_mismatch"
  | "mandate_expired"
  | "payee_not_allowed"
  | "amount_exceeds_max"
  | "budget_exceeded"
  | "velocity_exceeded"
  | "approval_required"
  | "within_policy";

/** A budget's state at decision time — what the stateless SDK hook cannot see. */
export interface BudgetState {
  name: string;
  window: BudgetWindow;
  limit: Atomic;
  /** Settled spend plus outstanding holds. */
  committed: Atomic;
  remaining: Atomic;
}

export interface Verdict {
  decision: Decision;
  reason: Reason;
  /** The exact policy clause that decided it, e.g. "budgets.daily-cap". */
  clause: string;
  /** Human-readable, for the report. Never parsed. */
  detail: string;
  /** Budget state at decision time. Evidence, not decoration. */
  budgets: BudgetState[];
  quote: Quote;
  /** Hash of the canonical policy document that produced this verdict. */
  policyHash: string;
  /** Unix ms. */
  at: number;
}

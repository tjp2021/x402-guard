/**
 * The policy document, and the verdict it produces.
 *
 * Design constraints, each earned from prior art in policy-language design:
 *
 * - No expression language. Fixed keys, typed values. Rego and XACML both died
 *   of unreadability; if a finance owner cannot read the policy, we have
 *   rebuilt XACML in JSON.
 * - Deny always wins, and evaluation never short-circuits on the first match.
 *   Stripe Radar's first-match-wins lets a broad Allow bypass every Block rule.
 * - Budgets are a first-class noun, not something left to an ad hoc callback.
 *   The SDK provides lifecycle hooks; this library supplies durable cumulative
 *   state so two under-limit payments cannot hide an over-limit total.
 * - Every verdict names the clause that decided it. XACML's most-cited
 *   operational failure was that a denial could not tell you why.
 */

import type { Atomic } from "./amount.js";

/** The only settlement rail version 0.1 is allowed to use. */
export const SETTLEMENT_PROFILE = Object.freeze({
  chainId: 84532,
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  decimals: 6,
  scheme: "exact",
} as const);

export interface SettlementProfile {
  readonly chainId: number;
  readonly network: string;
  readonly asset: string;
  readonly decimals: number;
  readonly scheme: string;
}

/** A payment quote, normalized from an x402 402 challenge. */
export interface Quote {
  /** Atomic units, as x402 quotes them. */
  readonly amount: Atomic;
  /** Token contract address. */
  readonly asset: string;
  /** CAIP-2 network id, e.g. "eip155:84532" (Base Sepolia). */
  readonly network: string;
  /** Recipient address. */
  readonly payTo: string;
  /** The resource being paid for. */
  readonly resource: string;
}

/** Durable settlement facts. Raw resource URLs never cross this boundary. */
export interface EvidenceQuote {
  readonly amount: Atomic;
  readonly asset: string;
  readonly network: string;
  readonly payTo: string;
  readonly resourceHash: string;
}

export interface Payee {
  readonly name: string;
  readonly address: string;
}

export type BudgetWindow = "rolling-24h" | "rolling-1h";

export interface Budget {
  readonly name: string;
  readonly window: BudgetWindow;
  /** Cumulative cap across every payment in the window. */
  readonly limit: Atomic;
}

/**
 * A parsed, validated policy. Amounts are already atomic; the loader does all
 * decimal parsing so the evaluator never sees a string.
 */
export interface Policy {
  readonly name: string;
  readonly version: number;
  readonly asset: {
    readonly symbol: string;
    /** Quotes on any other asset are denied — including mainnet addresses. */
    readonly address: string;
    /** Quotes on any other network are denied — including mainnet. */
    readonly network: string;
    readonly decimals: number;
  };
  readonly mandate: {
    readonly holder: string;
    readonly agent: string;
    /** Unix ms. A quote after this is denied. */
    readonly expires: number;
  };
  /** Allowlist. An unlisted payee is denied — default-deny, confirmed 2026-07-14. */
  readonly payees: readonly Payee[];
  readonly payments: {
    readonly maxPerPayment: Atomic;
    /** At or above this, the in-process caller must attest approval. */
    readonly requireApprovalOver: Atomic;
  };
  readonly budgets: readonly Budget[];
  readonly velocity: {
    readonly maxPaymentsPerHour: number;
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

/** A budget's state at decision time — what this durable layer contributes. */
export interface BudgetState {
  readonly name: string;
  readonly window: BudgetWindow;
  readonly limit: Atomic;
  /** Settled spend plus outstanding holds. */
  readonly committed: Atomic;
  readonly remaining: Atomic;
}

export interface Verdict {
  readonly decision: Decision;
  readonly reason: Reason;
  /** The exact policy clause that decided it, e.g. "budgets.daily-cap". */
  readonly clause: string;
  /** Human-readable, for the report. Never parsed. */
  readonly detail: string;
  /** Budget state at decision time. Evidence, not decoration. */
  readonly budgets: readonly BudgetState[];
  readonly quote: Quote;
  /** Hash of the canonical policy document that produced this verdict. */
  readonly policyHash: string;
  /** Unix ms. */
  readonly at: number;
}

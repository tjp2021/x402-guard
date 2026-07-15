import { describe, it, expect } from "vitest";
import { evaluate, type CommittedByBudget } from "../src/evaluate.js";
import type { Policy, Quote } from "../src/policy.js";
import { parseDecimal } from "../src/amount.js";

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_SEPOLIA = "eip155:84532";
const BASE_MAINNET = "eip155:8453";
const USDC_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const SELLER = "0xE5f6000000000000000000000000000000007788";
const STRANGER = "0xBAD0000000000000000000000000000000000BAD";

const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const d = 6;
const usd = (s: string) => parseDecimal(s, d);

const policy: Policy = {
  name: "research-agent-daily",
  version: 1,
  asset: {
    symbol: "USDC",
    address: USDC_BASE_SEPOLIA,
    network: BASE_SEPOLIA,
    decimals: d,
  },
  mandate: {
    holder: "research-team",
    agent: "research-agent-01",
    expires: Date.UTC(2026, 7, 1),
  },
  payees: [{ name: "Search Provider", address: SELLER }],
  payments: {
    maxPerPayment: usd("2.00"),
    requireApprovalOver: usd("0.50"),
  },
  budgets: [{ name: "daily-cap", window: "rolling-24h", limit: usd("5.00") }],
  velocity: { maxPaymentsPerHour: 10 },
};

const quote = (over: Partial<Quote> = {}): Quote => ({
  amount: usd("0.10"),
  asset: USDC_BASE_SEPOLIA,
  network: BASE_SEPOLIA,
  payTo: SELLER,
  resource: "https://api.example/report",
  ...over,
});

const spent = (amount: string): CommittedByBudget =>
  new Map([["daily-cap", usd(amount)]]);

const run = (q: Quote, committed: CommittedByBudget = new Map(), perHour = 0) =>
  evaluate({
    policy,
    quote: q,
    committed,
    paymentsLastHour: perHour,
    policyHash: "sha256:test",
    now: NOW,
  });

describe("the centerpiece: an agent cannot split an over-budget purchase", () => {
  it("blocks the third charge even though each is under every per-payment limit", () => {
    // The agent wants $5.40 but the daily cap is $5.00. Each individual payment
    // of $1.80 is under the $2.00 per-payment cap, so a per-transaction limit —
    // which is all x402's stateless hook can express — sees nothing wrong with
    // any of them. Only cumulative state catches the third.
    //
    // (These amounts are over the $0.50 approval threshold, so they route to a
    // human rather than passing silently. What matters here is that the first
    // two are NOT denied and the third IS — by the budget clause specifically.)
    const first = run(quote({ amount: usd("1.80") }), spent("0.00"));
    expect(first.decision).not.toBe("deny");

    const second = run(quote({ amount: usd("1.80") }), spent("1.80"));
    expect(second.decision).not.toBe("deny");

    // Third payment: $1.80 is still under the $2.00 per-payment cap. The
    // per-transaction limit sees nothing wrong. The budget does.
    const third = run(quote({ amount: usd("1.80") }), spent("3.60"));
    expect(third.decision).toBe("deny");
    expect(third.reason).toBe("budget_exceeded");
    expect(third.clause).toBe("budgets.daily-cap");
  });

  it("reports the state that made the denial possible", () => {
    const v = run(quote({ amount: usd("1.80") }), spent("4.10"));
    expect(v.decision).toBe("deny");
    expect(v.detail).toContain("5.90"); // projected
    expect(v.detail).toContain("5.00"); // limit
    expect(v.detail).toContain("4.10"); // already committed

    const budget = v.budgets[0]!;
    expect(budget.committed).toBe(usd("4.10"));
    expect(budget.limit).toBe(usd("5.00"));
    expect(budget.remaining).toBe(0n); // would be over; clamped, not negative
  });

  it("permits a payment that exactly reaches the cap, and denies one atomic unit past it", () => {
    // Boundary: spend == limit is within policy; spend == limit + 1 atomic unit
    // is not. Off-by-one here is the difference between a budget that holds and
    // one that quietly doesn't.
    const exact = run(quote({ amount: usd("0.90") }), spent("4.10"));
    expect(exact.decision).not.toBe("deny");
    expect(exact.budgets[0]!.remaining).toBe(0n);

    const oneOver = run(quote({ amount: usd("0.900001") }), spent("4.10"));
    expect(oneOver.decision).toBe("deny");
    expect(oneOver.reason).toBe("budget_exceeded");
  });
});

describe("deny clauses", () => {
  it("denies a payee that is not on the allowlist (default-deny)", () => {
    const v = run(quote({ payTo: STRANGER }));
    expect(v.decision).toBe("deny");
    expect(v.reason).toBe("payee_not_allowed");
    expect(v.clause).toBe("payees");
  });

  it("denies a quote on mainnet even when everything else looks fine", () => {
    // Without a network pin, a guard authored against testnet would happily
    // authorize real money.
    const v = run(quote({ network: BASE_MAINNET }));
    expect(v.decision).toBe("deny");
    expect(v.reason).toBe("network_mismatch");
  });

  it("denies a quote in a different token", () => {
    const v = run(quote({ asset: USDC_MAINNET }));
    expect(v.decision).toBe("deny");
    expect(v.reason).toBe("asset_mismatch");
  });

  it("denies a payment above the per-payment cap", () => {
    const v = run(quote({ amount: usd("2.01") }));
    expect(v.decision).toBe("deny");
    expect(v.reason).toBe("amount_exceeds_max");
  });

  it("denies once the mandate has expired", () => {
    const v = evaluate({
      policy,
      quote: quote(),
      committed: new Map(),
      paymentsLastHour: 0,
      policyHash: "sha256:test",
      now: Date.UTC(2026, 7, 2), // one day after expiry
    });
    expect(v.decision).toBe("deny");
    expect(v.reason).toBe("mandate_expired");
  });

  it("denies once the hourly velocity cap is met", () => {
    const v = run(quote(), new Map(), 10);
    expect(v.decision).toBe("deny");
    expect(v.reason).toBe("velocity_exceeded");
  });
});

describe("resolution order: deny always wins, and evaluation never short-circuits", () => {
  it("denies a hostile quote that would also have tripped approval", () => {
    // A server quoting 100x the expected price is over the per-payment cap AND
    // over the approval threshold. Deny must win; the payment must not merely
    // wait for a human who might click yes.
    const v = run(quote({ amount: usd("10.00") }));
    expect(v.decision).toBe("deny");
    expect(v.reason).toBe("amount_exceeds_max");
  });

  it("denies a stranger even when the amount is trivially small", () => {
    // The inverse of Stripe Radar's footgun: no permissive condition may
    // bypass a deny clause.
    const v = run(quote({ payTo: STRANGER, amount: usd("0.01") }));
    expect(v.decision).toBe("deny");
    expect(v.reason).toBe("payee_not_allowed");
  });

  it("still reports budget state on a non-budget denial", () => {
    // The verdict is evidence. A denial for one reason should not blind the
    // reader to how close the budget was.
    const v = run(quote({ payTo: STRANGER }), spent("4.00"));
    expect(v.reason).toBe("payee_not_allowed");
    expect(v.budgets[0]!.committed).toBe(usd("4.00"));
  });
});

describe("approval tier", () => {
  it("requires approval at or above the threshold", () => {
    const v = run(quote({ amount: usd("0.50") }));
    expect(v.decision).toBe("require_approval");
    expect(v.reason).toBe("approval_required");
    expect(v.clause).toBe("payments.require_approval_over");
  });

  it("allows below the threshold without bothering a human", () => {
    const v = run(quote({ amount: usd("0.499999") }));
    expect(v.decision).toBe("allow");
    expect(v.reason).toBe("within_policy");
  });
});

describe("the verdict is evidence", () => {
  it("carries the policy hash, the quote, the clause, and the time", () => {
    const q = quote({ amount: usd("1.80") });
    const v = run(q, spent("4.10"));
    expect(v.policyHash).toBe("sha256:test");
    expect(v.quote).toEqual(q);
    expect(v.at).toBe(NOW);
    expect(v.clause).toBe("budgets.daily-cap");
    // Machine-readable reason — a caller never string-matches an Error message.
    expect(v.reason).toBe("budget_exceeded");
  });

  it("is pure: the same inputs always give the same verdict", () => {
    const q = quote({ amount: usd("1.80") });
    expect(run(q, spent("4.10"))).toEqual(run(q, spent("4.10")));
  });
});

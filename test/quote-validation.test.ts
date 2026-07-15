import { describe, it, expect } from "vitest";
import { evaluate } from "../src/evaluate.js";
import type { Policy, Quote } from "../src/policy.js";
import { parseDecimal } from "../src/amount.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NET = "eip155:84532";
const SELLER = "0xE5f6000000000000000000000000000000007788";
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const usd = (s: string) => parseDecimal(s, 6);

const policy: Policy = {
  name: "p", version: 1,
  asset: { symbol: "USDC", address: USDC, network: NET, decimals: 6 },
  mandate: { holder: "research-team", agent: "a", expires: Date.UTC(2026, 7, 1) },
  payees: [{ name: "Seller", address: SELLER }],
  payments: { maxPerPayment: usd("2.00"), requireApprovalOver: usd("10.00") },
  budgets: [{ name: "daily-cap", window: "rolling-24h", limit: usd("5.00") }],
  velocity: { maxPaymentsPerHour: 10 },
};

const run = (quote: Quote) =>
  evaluate({ policy, quote, committed: new Map(), paymentsLastHour: 0, policyHash: "h", now: NOW });

const quote = (over: Partial<Quote> = {}): Quote => ({
  amount: usd("0.10"), asset: USDC, network: NET, payTo: SELLER,
  resource: "https://api.example/report", ...over,
});

describe("the quote is untrusted and validated at the boundary", () => {
  it("DENIES a negative amount instead of minting budget", () => {
    // A negative amount passes every `>` limit check, holds negative budget,
    // and increases the agent's spending power. It must die at the boundary.
    const v = run(quote({ amount: -1_000_000n }));
    expect(v.decision).toBe("deny");
    expect(v.clause).toBe("quote.amount");
  });

  it("denies a malformed payTo rather than letting it defeat the allowlist", () => {
    const v = run(quote({ payTo: "0xNOPE" }));
    expect(v.decision).toBe("deny");
    expect(v.clause).toBe("quote.payTo");
  });

  it("denies a malformed asset address", () => {
    const v = run(quote({ asset: "not-an-address" }));
    expect(v.decision).toBe("deny");
    expect(v.clause).toBe("quote.asset");
  });

  it("still allows a well-formed in-policy quote", () => {
    expect(run(quote()).decision).toBe("allow");
  });
});

import { describe, it, expect } from "vitest";
import { Guard } from "../src/guard.js";
import type { Policy, Quote } from "../src/policy.js";
import type { ChainReader, Clock, LedgerStore } from "../src/ports.js";
import type { Entry } from "../src/ledger.js";
import { parseDecimal } from "../src/amount.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NET = "eip155:84532";
const SELLER = "0xE5f6000000000000000000000000000000007788";
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const usd = (s: string) => parseDecimal(s, 6);

const policy: Policy = {
  name: "p",
  version: 1,
  asset: { symbol: "USDC", address: USDC, network: NET, decimals: 6 },
  mandate: { holder: "research-team", agent: "a", expires: Date.UTC(2026, 7, 1) },
  payees: [{ name: "Seller", address: SELLER }],
  // Approval kicks in at $0.50; per-payment cap $2.00.
  payments: { maxPerPayment: usd("2.00"), requireApprovalOver: usd("0.50") },
  budgets: [{ name: "daily-cap", window: "rolling-24h", limit: usd("5.00") }],
  velocity: { maxPaymentsPerHour: 10 },
};

const quote = (amount: string, over: Partial<Quote> = {}): Quote => ({
  amount: usd(amount),
  asset: USDC,
  network: NET,
  payTo: SELLER,
  resource: "https://api.example/report",
  ...over,
});

let clockNow = NOW;
const clock: Clock = { now: () => clockNow };
const store = (): LedgerStore => {
  const written: Entry[] = [];
  return { append: async (e) => void written.push(e), readAll: async () => [...written] };
};
const chain: ChainReader = { findPayment: async () => ({ found: false }) };

const open = () =>
  Guard.open({ policy, policyHash: "sha256:test", store: store(), chain, clock });

describe("the approval tier is a real gate, not a dead end", () => {
  it("returns require_approval for a payment over the threshold, with no approval", async () => {
    const g = await open();
    const r = await g.authorize(quote("1.00"));
    expect(r.decision).toBe("require_approval");
    expect(r.holdId).toBeUndefined();
  });

  it("lets the SAME quote through once a human approves it — and holds the budget", async () => {
    // The bug this closes: before approve() existed, an approval-tier payment
    // repeated require_approval forever, so the only way to pay was to bypass
    // the guard — which put the money outside the ledger and outside the budget.
    const g = await open();
    const q = quote("1.00");

    expect((await g.authorize(q)).decision).toBe("require_approval");

    g.approve(q);
    const r = await g.authorize(q);

    expect(r.decision).toBe("allow");
    expect(r.holdId).toBeDefined();
    // And it counts against the budget — the whole point of routing it through.
    expect(g.history().some((e) => e.status === "held")).toBe(true);
  });

  it("does not let a DIFFERENT quote through on someone else's approval", async () => {
    // An approval binds to one quote. Approving a $1.00 payment must not
    // authorize a $1.90 one, or a payment to a different payee.
    const g = await open();
    g.approve(quote("1.00"));

    expect((await g.authorize(quote("1.90"))).decision).toBe("require_approval");
    expect(
      (await g.authorize(quote("1.00", { payTo: "0x1111111111111111111111111111111111111111" }))).decision,
    ).toBe("deny"); // different payee: not allowlisted
  });

  it("consumes the approval — one yes authorizes one payment, no replay", async () => {
    const g = await open();
    const q = quote("1.00");
    g.approve(q);

    expect((await g.authorize(q)).decision).toBe("allow");
    // Second attempt at the same quote: the approval is spent.
    expect((await g.authorize(q)).decision).toBe("require_approval");
  });

  it("does not honor an expired approval", async () => {
    const g = await Guard.open({
      policy,
      policyHash: "sha256:test",
      store: store(),
      chain,
      clock,
      approvalTtlMs: 5 * 60 * 1000, // 5 min
    });
    const q = quote("1.00");
    g.approve(q); // granted at NOW, valid until NOW + 5min

    clockNow = NOW + 6 * 60 * 1000; // 6 min later
    expect((await g.authorize(q)).decision).toBe("require_approval");
    clockNow = NOW; // reset for other tests
  });

  it("still lets a below-threshold payment through with no approval at all", async () => {
    const g = await open();
    expect((await g.authorize(quote("0.49"))).decision).toBe("allow");
  });
});

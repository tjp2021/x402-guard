import { describe, it, expect } from "vitest";
import { Ledger, LedgerError } from "../src/ledger.js";
import { evaluate } from "../src/evaluate.js";
import type { Policy, Quote } from "../src/policy.js";
import { parseDecimal } from "../src/amount.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NET = "eip155:84532";
const SELLER = "0xE5f6000000000000000000000000000000007788";
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const d = 6;
const usd = (s: string) => parseDecimal(s, d);

const policy: Policy = {
  name: "research-agent-daily",
  version: 1,
  asset: { symbol: "USDC", address: USDC, network: NET, decimals: d },
  mandate: { holder: "research-team", agent: "research-agent-01", expires: Date.UTC(2026, 7, 1) },
  payees: [{ name: "Search Provider", address: SELLER }],
  payments: { maxPerPayment: usd("2.00"), requireApprovalOver: usd("10.00") },
  budgets: [{ name: "daily-cap", window: "rolling-24h", limit: usd("5.00") }],
  velocity: { maxPaymentsPerHour: 10 },
};

const quote = (amount: string): Quote => ({
  amount: usd(amount),
  asset: USDC,
  network: NET,
  payTo: SELLER,
  resource: "https://api.example/report",
});

const gate = (l: Ledger, q: Quote, now = NOW) =>
  evaluate({
    policy,
    quote: q,
    committed: l.committed(policy, now),
    paymentsLastHour: l.paymentsLastHour(now),
    policyHash: "sha256:test",
    now,
  });

describe("the race: two concurrent payments cannot both spend the same budget", () => {
  it("denies the second payment because the first one's hold already reserved the funds", () => {
    // This is the bug the whole hold mechanism exists to prevent, and it is the
    // bug a naive check-then-pay guard has: agent has $0.90 left, fires two
    // $0.80 payments at once, both check against $0.90, both pass, both settle,
    // budget breached — by the tool whose entire job is preventing that.
    const l = new Ledger();
    l.hold(quote("4.10"), NOW);
    l.confirm("hold-1", "0xsettled");
    // $0.90 of the $5.00 daily cap remains.

    const first = gate(l, quote("0.80"));
    expect(first.decision).toBe("allow");
    l.hold(quote("0.80"), NOW); // reserve BEFORE paying — this is the whole point

    // The second payment evaluates while the first is still in flight. It must
    // see the hold, not the pre-hold balance.
    const second = gate(l, quote("0.80"));
    expect(second.decision).toBe("deny");
    expect(second.reason).toBe("budget_exceeded");
    expect(second.detail).toContain("4.90"); // already committed, incl. the hold
  });
});

describe("hold lifecycle", () => {
  it("counts an outstanding hold against the budget", () => {
    const l = new Ledger();
    l.hold(quote("2.00"), NOW);
    expect(l.committed(policy, NOW).get("daily-cap")).toBe(usd("2.00"));
  });

  it("does not double-count a hold once it settles", () => {
    // The log is append-only: settling appends a second entry for the same
    // hold. Summing raw entries would count the money twice and silently
    // halve the agent's budget.
    const l = new Ledger();
    l.hold(quote("2.00"), NOW);
    l.confirm("hold-1", "0xabc");
    expect(l.committed(policy, NOW).get("daily-cap")).toBe(usd("2.00"));
    expect(l.history()).toHaveLength(2); // both entries preserved
  });

  it("gives the budget back when a payment definitively did not happen", () => {
    const l = new Ledger();
    l.hold(quote("2.00"), NOW);
    l.release("hold-1", "server returned 500 before payment was broadcast");
    expect(l.committed(policy, NOW).get("daily-cap")).toBe(0n);
  });

  it("KEEPS an indeterminate hold committed and surfaces it for a human", () => {
    // The unsafe move is auto-releasing. If the payment might have settled,
    // giving the budget back lets the agent spend the same money twice. The
    // balance stays wrong in the SAFE direction until a human resolves it.
    const l = new Ledger();
    l.hold(quote("2.00"), NOW);
    l.flag("hold-1", "RPC timeout; settlement status unknown");

    expect(l.committed(policy, NOW).get("daily-cap")).toBe(usd("2.00"));
    expect(l.needsReconciliation()).toHaveLength(1);
    expect(l.needsReconciliation()[0]!.note).toContain("unknown");
  });

  it("refuses to resolve a hold twice", () => {
    const l = new Ledger();
    l.hold(quote("1.00"), NOW);
    l.confirm("hold-1", "0xabc");
    expect(() => l.confirm("hold-1", "0xdef")).toThrow(LedgerError);
    expect(() => l.release("hold-1", "changed my mind")).toThrow(LedgerError);
  });

  it("refuses to resolve a hold it never issued", () => {
    const l = new Ledger();
    expect(() => l.confirm("hold-99", "0xabc")).toThrow(LedgerError);
  });
});

describe("windows", () => {
  it("drops spend that has aged out of the rolling window", () => {
    const l = new Ledger();
    l.hold(quote("4.00"), NOW - 25 * HOUR); // yesterday
    l.confirm("hold-1", "0xold");
    l.hold(quote("1.00"), NOW);
    l.confirm("hold-2", "0xnew");

    // Only the recent $1.00 counts against a rolling-24h cap.
    expect(l.committed(policy, NOW).get("daily-cap")).toBe(usd("1.00"));
  });

  it("counts velocity only within the trailing hour, ignoring released holds", () => {
    const l = new Ledger();
    l.hold(quote("0.10"), NOW - 2 * HOUR); // too old
    l.hold(quote("0.10"), NOW);
    l.hold(quote("0.10"), NOW);
    l.release("hold-3", "aborted"); // released payments never happened

    expect(l.paymentsLastHour(NOW)).toBe(1);
  });
});

describe("history is evidence", () => {
  it("never mutates or deletes — state changes are new entries", () => {
    const l = new Ledger();
    l.hold(quote("1.00"), NOW);
    l.flag("hold-1", "unknown outcome");
    l.hold(quote("0.50"), NOW);
    l.confirm("hold-2", "0xabc");

    const h = l.history();
    expect(h).toHaveLength(4);
    expect(h.map((e) => e.status)).toEqual(["held", "indeterminate", "held", "settled"]);
    // The original 'held' entry survives its own supersession.
    expect(h[0]!.status).toBe("held");
    expect(h[3]!.transaction).toBe("0xabc");
  });
});

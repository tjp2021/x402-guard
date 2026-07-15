import { describe, it, expect } from "vitest";
import { loadPolicy, hashPolicy, PolicyError } from "../src/load.js";
import { parseDecimal } from "../src/amount.js";

const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const usd = (s: string) => parseDecimal(s, 6);

/** The sample policy from the design doc, as a plain document. */
const valid = () => ({
  policy: "research-agent-daily",
  version: 1,
  asset: {
    symbol: "USDC",
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    network: "eip155:84532",
    decimals: 6,
  },
  mandate: {
    holder: "research-team",
    agent: "research-agent-01",
    expires: "2026-08-01T00:00:00Z",
  },
  payees: {
    allow: [{ name: "Search Provider", address: "0xE5f6000000000000000000000000000000007788" }],
  },
  payments: { max_per_payment: "2.00", require_approval_over: "0.50" },
  budgets: [{ name: "daily-cap", window: "rolling-24h", limit: "5.00" }],
  velocity: { max_payments_per_hour: 10 },
});

/** Load with one field replaced, for the failure cases. */
const withField = (mutate: (d: ReturnType<typeof valid>) => void) => {
  const d = valid();
  mutate(d);
  return () => loadPolicy(d, NOW);
};

describe("loading a valid policy", () => {
  it("parses decimals into atomic units so the evaluator never sees a string", () => {
    const { policy } = loadPolicy(valid(), NOW);
    expect(policy.payments.maxPerPayment).toBe(usd("2.00"));
    expect(policy.payments.requireApprovalOver).toBe(usd("0.50"));
    expect(policy.budgets[0]!.limit).toBe(usd("5.00"));
    expect(policy.mandate.expires).toBe(Date.UTC(2026, 7, 1));
    expect(policy.payees[0]!.name).toBe("Search Provider");
  });
});

describe("the hash identifies the policy, not its formatting", () => {
  it("is stable across key order and whitespace", () => {
    const a = { policy: "p", limits: { max: "1.00", min: "0.10" } };
    const b = { limits: { min: "0.10", max: "1.00" }, policy: "p" };
    expect(hashPolicy(a)).toBe(hashPolicy(b));
  });

  it("changes when a limit changes — this is the point", () => {
    const before = valid();
    const after = valid();
    after.budgets[0]!.limit = "50.00"; // a 10x budget increase
    expect(hashPolicy(after)).not.toBe(hashPolicy(before));
  });

  it("is what a verdict carries, so an edited policy cannot masquerade as the one in force", () => {
    const { hash } = loadPolicy(valid(), NOW);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("validation fails closed — a policy that cannot be understood permits nothing", () => {
  it("rejects a typo in a limit rather than treating it as unlimited", () => {
    // "5,00" (comma) is the single most likely spending-limit typo on earth.
    expect(withField((d) => { d.budgets[0]!.limit = "5,00"; })).toThrow(PolicyError);
    expect(withField((d) => { d.budgets[0]!.limit = "five dollars"; })).toThrow(PolicyError);
    expect(withField((d) => { d.budgets[0]!.limit = "-5.00"; })).toThrow(PolicyError);
  });

  it("rejects more precision than the asset carries, rather than rounding it away", () => {
    expect(withField((d) => { d.payments.max_per_payment = "1.0000005"; }))
      .toThrow(/exceeds scale 6/);
  });

  it("rejects a mandate that has already expired", () => {
    // Better to fail at load than at the agent's first payment.
    expect(withField((d) => { d.mandate.expires = "2020-01-01T00:00:00Z"; }))
      .toThrow(/already expired/);
  });

  it("rejects an empty payee allowlist", () => {
    // Default-deny taken to its conclusion: the agent could pay nobody. Almost
    // certainly an authoring mistake, and it fails in the direction you notice
    // late.
    expect(withField((d) => { d.payees.allow = []; })).toThrow(/could pay nobody/);
  });

  it("rejects a malformed payee address", () => {
    expect(withField((d) => { d.payees.allow[0]!.address = "0xNOPE"; }))
      .toThrow(/not a 0x address/);
  });

  it("rejects an unreachable approval tier", () => {
    // If approval kicks in above $5 but no payment above $2 is allowed, the
    // approval tier is dead code and the author does not know it.
    expect(withField((d) => { d.payments.require_approval_over = "5.00"; }))
      .toThrow(/no payment could ever reach the approval tier/);
  });

  it("rejects a budget smaller than a single permitted payment", () => {
    expect(withField((d) => { d.budgets[0]!.limit = "1.00"; }))
      .toThrow(/a single permitted payment would exceed the budget/);
  });

  it("rejects duplicate budget names, which would silently shadow a limit", () => {
    expect(
      withField((d) => {
        d.budgets.push({ name: "daily-cap", window: "rolling-1h", limit: "3.00" });
      }),
    ).toThrow(/duplicate budget name/);
  });

  it("rejects an unknown budget window rather than ignoring it", () => {
    expect(withField((d) => { (d.budgets[0]! as { window: string }).window = "monthly"; }))
      .toThrow(/expected one of/);
  });

  it("rejects a velocity cap of zero, which would block every payment", () => {
    expect(withField((d) => { d.velocity.max_payments_per_hour = 0; }))
      .toThrow(/would block every payment/);
  });

  it("rejects a network id that is not CAIP-2", () => {
    expect(withField((d) => { d.asset.network = "base-sepolia"; }))
      .toThrow(/not a CAIP-2 id/);
  });

  it("names the offending field, so the error is actionable", () => {
    // "invalid policy" is useless. "payees.allow[0].address: not a 0x address"
    // tells the author exactly what to fix.
    expect(withField((d) => { d.payees.allow[0]!.address = "0xNOPE"; }))
      .toThrow(/payees\.allow\[0\]\.address/);
  });
});

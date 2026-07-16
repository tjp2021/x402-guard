import { describe, expect, it } from "vitest";
import { hashPolicy, isLoadedPolicy, loadPolicy, PolicyError } from "../src/load.js";
import { SETTLEMENT_PROFILE } from "../src/policy.js";
import type { Policy } from "../src/policy.js";
import { NOW, PAYEE, policyDocument } from "./core-fixtures.js";

type Doc = ReturnType<typeof policyDocument> & {
  asset: { symbol: string; address: string; network: string; decimals: number };
  mandate: { holder: string; agent: string; expires: string };
  payees: { allow: Array<{ name: string; address: string }> };
  payments: { max_per_payment: string; require_approval_over: string };
  budgets: Array<{ name: string; window: string; limit: string }>;
  velocity: { max_payments_per_hour: number };
};

const doc = (): Doc => policyDocument() as Doc;
const loading = (mutate: (value: Doc) => void) => {
  const value = doc();
  mutate(value);
  return () => loadPolicy(value, NOW);
};

describe("LoadedPolicy", () => {
  it("couples one normalized immutable policy to its own hash", () => {
    const source = doc();
    source.asset.address = SETTLEMENT_PROFILE.asset.toUpperCase().replace("0X", "0x");
    source.payees.allow[0]!.address = PAYEE.toUpperCase().replace("0X", "0x");

    const loaded = loadPolicy(source, NOW);
    const originalHash = loaded.hash;
    source.payments.max_per_payment = "999.00";
    source.payees.allow[0]!.name = "mutated";

    expect(isLoadedPolicy(loaded)).toBe(true);
    expect(loaded.hash).toBe(originalHash);
    expect(loaded.hash).toBe(hashPolicy(loaded.policy));
    expect(loaded.policy.asset.address).toBe(SETTLEMENT_PROFILE.asset.toLowerCase());
    expect(loaded.policy.payees[0]!.address).toBe(PAYEE.toLowerCase());
    expect(loaded.policy.payments.maxPerPayment).toBe(10_000_000n);
    expect(loaded.policy.payees[0]!.name).toBe("fixture-payee");
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.policy)).toBe(true);
    expect(Object.isFrozen(loaded.policy.payees)).toBe(true);
    expect(Object.isFrozen(loaded.policy.payees[0])).toBe(true);
  });

  it("does not recognize a caller-forged policy/hash pair", () => {
    const loaded = loadPolicy(doc(), NOW);
    const forged = Object.freeze({ policy: loaded.policy, hash: loaded.hash });
    expect(isLoadedPolicy(forged)).toBe(false);
  });

  it("hashes canonical policy meaning and changes when a limit changes", () => {
    const before = loadPolicy(doc(), NOW);
    const reordered: Policy = {
      velocity: before.policy.velocity,
      budgets: before.policy.budgets,
      payments: before.policy.payments,
      payees: before.policy.payees,
      mandate: before.policy.mandate,
      asset: before.policy.asset,
      version: before.policy.version,
      name: before.policy.name,
    };
    const changed: Policy = {
      ...before.policy,
      budgets: before.policy.budgets.map((budget) =>
        budget.name === "daily" ? { ...budget, limit: budget.limit + 1n } : budget,
      ),
    };

    expect(hashPolicy(reordered)).toBe(before.hash);
    expect(hashPolicy(changed)).not.toBe(before.hash);
    expect(before.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("fail-closed policy validation", () => {
  it("pins the exact settlement network, token, and decimals", () => {
    expect(loading((value) => { value.asset.network = "eip155:1"; }))
      .toThrow(/supports only/);
    expect(loading((value) => { value.asset.address = PAYEE; }))
      .toThrow(/supports only Circle/);
    expect(loading((value) => { value.asset.decimals = 18; }))
      .toThrow(/requires 6/);
  });

  it("rejects expired mandates, empty allowlists, and malformed addresses", () => {
    expect(loading((value) => { value.mandate.expires = "2020-01-01T00:00:00Z"; }))
      .toThrow(/already expired/);
    expect(loading((value) => { value.payees.allow = []; })).toThrow(/could pay nobody/);
    expect(loading((value) => { value.payees.allow[0]!.address = "0xNOPE"; }))
      .toThrow(/payees\.allow\[0\]\.address/);
  });

  it("rejects malformed, over-precise, negative, and uint256-overflow amounts", () => {
    expect(loading((value) => { value.budgets[0]!.limit = "5,00"; }))
      .toThrow(PolicyError);
    expect(loading((value) => { value.payments.max_per_payment = "1.0000005"; }))
      .toThrow(/exceeds scale 6/);
    expect(loading((value) => { value.budgets[0]!.limit = "-5.00"; }))
      .toThrow(PolicyError);
    expect(loading((value) => {
      value.payments.max_per_payment = (1n << 256n).toString();
    })).toThrow(/uint256/);
  });

  it("rejects unreachable or internally contradictory limits", () => {
    expect(loading((value) => { value.payments.require_approval_over = "11.00"; }))
      .toThrow(/no payment could ever reach/);
    expect(loading((value) => { value.budgets[0]!.limit = "9.00"; }))
      .toThrow(/single permitted payment/);
    expect(loading((value) => {
      value.budgets.push({ name: "daily", window: "rolling-1h", limit: "50.00" });
    })).toThrow(/duplicate budget name/);
    expect(loading((value) => { value.budgets[0]!.window = "monthly"; }))
      .toThrow(/expected one of/);
    expect(loading((value) => { value.velocity.max_payments_per_hour = 0; }))
      .toThrow(/would block every payment/);
  });

  it("rejects unknown keys instead of silently disabling a limit", () => {
    expect(loading((value) => {
      (value.payments as Record<string, unknown>)["max_per_paymant"] = "1.00";
    })).toThrow(/unknown key/);
  });
});

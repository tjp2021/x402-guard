import { describe, it, expect } from "vitest";
import { x402GuardHooks } from "../src/adapters/x402.js";
import { Guard } from "../src/guard.js";
import type { ChainReader, Clock, LedgerStore, Entry } from "../src/index.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NET = "eip155:84532";
const SELLER = "0xE5f6070809A0b1C2d3E4f5061728394A5b6C7788";
const PAYER = "0xA1b2000000000000000000000000000000001234";
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);

const policy = {
  name: "p", version: 1,
  asset: { symbol: "USDC", address: USDC, network: NET, decimals: 6 },
  mandate: { holder: "research-team", agent: "a", expires: Date.UTC(2026, 7, 1) },
  payees: [{ name: "Seller", address: SELLER }],
  payments: { maxPerPayment: 2_000_000n, requireApprovalOver: 10_000_000n },
  budgets: [{ name: "daily-cap", window: "rolling-24h" as const, limit: 5_000_000n }],
  velocity: { maxPaymentsPerHour: 10 },
};

const store = (): LedgerStore => {
  const w: Entry[] = [];
  return { append: async (e) => void w.push(e), readAll: async () => [...w] };
};
const chain: ChainReader = { findPayment: async () => ({ found: false }) };
const clock: Clock = { now: () => NOW };
const open = () => Guard.open({ policy, policyHash: "sha256:test", store: store(), chain, clock });

// Build the SDK-shaped contexts the hooks receive.
const requirements = (amount: string) => ({
  scheme: "exact", network: NET, asset: USDC, amount, payTo: SELLER, maxTimeoutSeconds: 60, extra: {},
});
const paymentRequired = () => ({ resource: { url: "https://api.example/report" }, accepts: [] });
const payloadWith = (nonce: string, validBeforeSec: number) => ({
  payload: { authorization: { from: PAYER, to: SELLER, value: "0", validAfter: "0",
    validBefore: String(validBeforeSec), nonce } },
});

/** Drive one full payment through the hooks the way the x402 client would. */
async function pay(hooks: ReturnType<typeof x402GuardHooks>, amount: string, nonce: string) {
  const req = requirements(amount);
  const before = await hooks.onBeforePaymentCreation({
    paymentRequired: paymentRequired(), selectedRequirements: req,
  });
  if (before && "abort" in before) return { aborted: true, reason: before.reason };

  // ...the SDK signs the payload here, producing the nonce + validBefore...
  const payload = payloadWith(nonce, Math.floor(NOW / 1000) + 3600);
  await hooks.onAfterPaymentCreation({
    paymentRequired: paymentRequired(), selectedRequirements: req, paymentPayload: payload,
  });
  await hooks.onPaymentResponse({
    paymentPayload: payload,
    settleResponse: { success: true, transaction: `0x${nonce.slice(2, 10)}`, payer: PAYER },
  });
  return { aborted: false };
}

describe("the x402 adapter wires the guard into the real hook lifecycle", () => {
  it("blocks the split-purchase attack through the actual before/after/response hooks", async () => {
    const guard = await open();
    const hooks = x402GuardHooks(guard);

    // Three $1.80 payments against a $5.00 cap, each under the $2.00 per-payment
    // limit — driven through the same hooks the x402 client calls.
    const a = await pay(hooks, "1800000", "0x" + "a".repeat(64));
    const b = await pay(hooks, "1800000", "0x" + "b".repeat(64));
    const c = await pay(hooks, "1800000", "0x" + "c".repeat(64));

    expect(a.aborted).toBe(false);
    expect(b.aborted).toBe(false);
    expect(c.aborted).toBe(true);              // the budget catches the third
    expect(c.reason).toContain("budget_exceeded");
  });

  it("records the settlement and the validBefore through the hooks", async () => {
    const guard = await open();
    const hooks = x402GuardHooks(guard);
    await pay(hooks, "1000000", "0x" + "d".repeat(64));

    const settled = guard.history().find((e) => e.status === "settled");
    expect(settled).toBeDefined();
    expect(settled!.nonce).toBe("0x" + "d".repeat(64));
    expect(settled!.payer).toBe(PAYER);
    // validBefore captured as ms (seconds from the payload × 1000).
    expect(settled!.validBefore).toBe((Math.floor(NOW / 1000) + 3600) * 1000);
  });

  it("denies a payment in an unsupported scheme rather than waving it through", async () => {
    const guard = await open();
    const hooks = x402GuardHooks(guard);
    const before = await hooks.onBeforePaymentCreation({
      paymentRequired: paymentRequired(),
      selectedRequirements: { ...requirements("1000000"), scheme: "some-other-scheme" },
    });
    expect(before).toEqual({ abort: true, reason: expect.stringContaining("unsupported scheme") });
  });

  it("aborts cleanly on a malformed amount from a hostile server, without throwing", async () => {
    // A hostile 402 can send an amount that is not an integer. The before-hook
    // must return a clean abort, not let BigInt throw out of the SDK hook.
    const guard = await open();
    const hooks = x402GuardHooks(guard);
    const before = await hooks.onBeforePaymentCreation({
      paymentRequired: paymentRequired(),
      selectedRequirements: { ...requirements("not-a-number"), scheme: "exact" },
    });
    expect(before).toEqual({ abort: true, reason: expect.stringContaining("unparseable payment amount") });
  });

  it("abandons the hold when signing fails — no payload, budget released", async () => {
    const guard = await open();
    const hooks = x402GuardHooks(guard);
    const req = requirements("1000000");

    await hooks.onBeforePaymentCreation({ paymentRequired: paymentRequired(), selectedRequirements: req });
    // signing throws instead of producing a payload
    await hooks.onPaymentCreationFailure({
      paymentRequired: paymentRequired(), selectedRequirements: req, error: new Error("signer rejected"),
    });

    const released = guard.history().find((e) => e.status === "released");
    expect(released).toBeDefined();
    expect(guard.history().some((e) => e.status === "held" && e.nonce)).toBe(false);
  });
});

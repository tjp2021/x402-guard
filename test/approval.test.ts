import { describe, expect, it } from "vitest";
import { Guard } from "../src/guard.js";
import { loadPolicy } from "../src/load.js";
import type { Quote } from "../src/policy.js";
import {
  MemoryStore,
  NOW,
  PAYER,
  TestChain,
  TestClock,
  policyDocument,
  quote,
} from "./core-fixtures.js";

function approvalPolicy(maxPaymentsPerHour = 10) {
  const document = policyDocument() as ReturnType<typeof policyDocument> & {
    payments: { max_per_payment: string; require_approval_over: string };
    budgets: Array<{ name: string; window: string; limit: string }>;
    velocity: { max_payments_per_hour: number };
  };
  document.payments.max_per_payment = "2.00";
  document.payments.require_approval_over = "0.50";
  document.budgets[0]!.limit = "5.00";
  document.budgets[1]!.limit = "5.00";
  document.velocity.max_payments_per_hour = maxPaymentsPerHour;
  return loadPolicy(document, NOW);
}

async function open(
  clock = new TestClock(),
  approvalTtlMs?: number,
  maxPaymentsPerHour = 10,
) {
  return Guard.open({
    loadedPolicy: approvalPolicy(maxPaymentsPerHour),
    store: new MemoryStore(),
    chain: new TestChain(),
    clock,
    ...(approvalTtlMs === undefined ? {} : { approvalTtlMs }),
  });
}

describe("caller-attested advisory approval", () => {
  it("returns require_approval without an attestation and writes no hold", async () => {
    const guard = await open();
    const result = await guard.authorize(quote(1_000_000n));
    expect(result.decision).toBe("require_approval");
    expect(result.holdId).toBeUndefined();
    expect(guard.history()).toHaveLength(0);
  });

  it("allows the same quote once after the caller attests and reserves its budget", async () => {
    const guard = await open();
    const payment = quote(1_000_000n);
    await guard.attestCallerApproval(payment);

    const allowed = await guard.authorize(payment);
    expect(allowed.decision).toBe("allow");
    if (allowed.decision !== "allow") throw new Error("expected allowed fixture");
    await guard.markCreationIndeterminate(allowed.holdId, "creation_outcome_unknown");
    expect((await guard.authorize(payment)).decision).toBe("require_approval");
    expect(guard.history()).toHaveLength(2);
  });

  it("snapshots the attested quote and never transfers it to a different quote", async () => {
    const guard = await open();
    const mutable = { ...quote(1_000_000n) };
    const attesting = guard.attestCallerApproval(mutable);
    mutable.amount = 1_900_000n;
    mutable.payTo = PAYER;
    await attesting;

    expect((await guard.authorize(quote(1_900_000n))).decision).toBe("require_approval");
    expect((await guard.authorize({ ...quote(1_000_000n), payTo: PAYER })).decision)
      .toBe("deny");
    expect((await guard.authorize(quote(1_000_000n))).decision).toBe("allow");
  });

  it("burns an attestation on a denied attempt instead of banking it", async () => {
    const clock = new TestClock();
    const guard = await open(clock, undefined, 2);
    for (let index = 0; index < 2; index += 1) {
      const authorization = await guard.authorize(quote(490_000n));
      expect(authorization.decision).toBe("allow");
      if (authorization.decision !== "allow") throw new Error("expected allowed fixture");
      await guard.markCreationIndeterminate(
        authorization.holdId,
        "creation_outcome_unknown",
      );
    }

    const approved = quote(1_000_000n);
    await guard.attestCallerApproval(approved);
    expect((await guard.authorize(approved)).decision).toBe("deny");
    clock.value += 60 * 60 * 1000 + 1;
    expect((await guard.authorize(approved)).decision).toBe("require_approval");
  });

  it("does not honor an expired attestation", async () => {
    const clock = new TestClock();
    const guard = await open(clock, 5 * 60 * 1000);
    const payment = quote(1_000_000n);
    await guard.attestCallerApproval(payment);
    clock.value += 6 * 60 * 1000;
    expect((await guard.authorize(payment)).decision).toBe("require_approval");
  });

  it("rejects approval-expiry safe-integer overflow", async () => {
    const clock = new TestClock();
    const ttl = Number.MAX_SAFE_INTEGER - NOW;
    const guard = await open(clock, ttl);
    clock.value += 1;
    await expect(guard.attestCallerApproval(quote(1_000_000n)))
      .rejects.toThrow(/expiry exceeds safe integer/);
    expect(guard.isFaulted()).toBe(false);
  });

  it("allows below-threshold payments without any attestation", async () => {
    const guard = await open();
    expect((await guard.authorize(quote(490_000n))).decision).toBe("allow");
  });
});

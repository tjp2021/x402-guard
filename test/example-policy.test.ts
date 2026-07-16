import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Guard } from "../src/guard.js";
import { loadPolicyFile } from "../src/load-file.js";
import type { Quote } from "../src/policy.js";
import { MemoryStore, TestChain, TestClock } from "./core-fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const POLICY = join(here, "..", "examples", "research-agent.policy.yaml");
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const SELLER = "0xE5f6070809A0b1C2d3E4f5061728394A5b6C7788";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const payment: Quote = {
  amount: 1_800_000n,
  asset: USDC,
  network: "eip155:84532",
  payTo: SELLER,
  resource: "https://api.example/report",
};

describe("the shipped example policy", () => {
  it("loads as an opaque immutable policy/hash pair", async () => {
    const loaded = await loadPolicyFile(POLICY, NOW);
    expect(loaded.policy.name).toBe("research-agent-daily");
    expect(loaded.policy.budgets[0]!.limit).toBe(5_000_000n);
    expect(loaded.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.policy)).toBe(true);
  });

  it("blocks split spend even when each charge has caller-attested approval", async () => {
    const loaded = await loadPolicyFile(POLICY, NOW);
    const guard = await Guard.open({
      loadedPolicy: loaded,
      store: new MemoryStore(),
      chain: new TestChain(),
      clock: new TestClock(NOW),
    });

    await guard.attestCallerApproval(payment);
    const first = await guard.authorize(payment);
    if (first.decision !== "allow") throw new Error("expected first payment to be allowed");
    await guard.markCreationIndeterminate(first.holdId, "creation_outcome_unknown");
    await guard.attestCallerApproval(payment);
    const second = await guard.authorize(payment);
    if (second.decision !== "allow") throw new Error("expected second payment to be allowed");
    await guard.markCreationIndeterminate(second.holdId, "creation_outcome_unknown");
    await guard.attestCallerApproval(payment);
    const third = await guard.authorize(payment);

    expect(first.decision).toBe("allow");
    expect(second.decision).toBe("allow");
    expect(third.decision).toBe("deny");
    expect(third.verdict.reason).toBe("budget_exceeded");
    expect(guard.history()).toHaveLength(4);
  });
});

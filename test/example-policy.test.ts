import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadPolicyFile } from "../src/load-file.js";
import { Guard } from "../src/guard.js";
import type { Quote } from "../src/policy.js";
import type { ChainReader, Clock, LedgerStore, Entry } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const POLICY = join(here, "..", "examples", "research-agent.policy.yaml");
// A fixed "now" before the example mandate's 2026-12-31 expiry.
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);

const SELLER = "0xE5f6070809A0b1C2d3E4f5061728394A5b6C7788"; // from the example
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const quote = (amount: bigint): Quote => ({
  amount, asset: USDC, network: "eip155:84532", payTo: SELLER,
  resource: "https://api.example/report",
});

const store = (): LedgerStore => {
  const w: Entry[] = [];
  return { append: async (e) => void w.push(e), readAll: async () => [...w] };
};
const chain: ChainReader = { findPayment: async () => ({ found: false }) };
const clock: Clock = { now: () => NOW };

describe("the shipped example policy is real and enforces the headline claim", () => {
  it("loads from the YAML file a human would actually write", async () => {
    const { policy, hash } = await loadPolicyFile(POLICY, NOW);
    expect(policy.name).toBe("research-agent-daily");
    expect(policy.budgets[0]!.limit).toBe(5_000_000n); // "5.00" USDC
    expect(hash).toMatch(/^sha256:/);
  });

  it("blocks an agent splitting an over-budget spend into under-limit charges", async () => {
    const { policy, hash } = await loadPolicyFile(POLICY, NOW);
    const guard = await Guard.open({
      policy, policyHash: hash, store: store(), chain, clock,
    });

    // $5.00 daily cap, $2.00 per-payment cap. Three $1.80 charges = $5.40.
    // Each is under the per-payment cap, so a stateless per-transaction hook
    // would wave all three through. Cumulative budget denies the third.
    // (These are over the $0.50 approval threshold, so a human approves each —
    // and the third is still denied, because deny wins over approval.)
    const q = quote(1_800_000n);

    guard.approve(q);
    const a = await guard.authorize(q);
    await guard.confirm(a.holdId!, "0x1");

    guard.approve(q);
    const b = await guard.authorize(q);
    await guard.confirm(b.holdId!, "0x2");

    guard.approve(q);
    const c = await guard.authorize(q);

    expect(a.decision).toBe("allow");
    expect(b.decision).toBe("allow");
    expect(c.decision).toBe("deny");
    expect(c.verdict.reason).toBe("budget_exceeded");
  });
});

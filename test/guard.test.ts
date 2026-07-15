import { describe, it, expect } from "vitest";
import { Guard } from "../src/guard.js";
import { Ledger } from "../src/ledger.js";
import type { Entry } from "../src/ledger.js";
import type { Policy, Quote } from "../src/policy.js";
import type { ChainReader, Clock, LedgerStore, PaymentStatus } from "../src/ports.js";
import { parseDecimal } from "../src/amount.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NET = "eip155:84532";
const SELLER = "0xE5f6000000000000000000000000000000007788";
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const usd = (s: string) => parseDecimal(s, 6);

const policy: Policy = {
  name: "research-agent-daily",
  version: 1,
  asset: { symbol: "USDC", address: USDC, network: NET, decimals: 6 },
  mandate: { holder: "research-team", agent: "a", expires: Date.UTC(2026, 7, 1) },
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

/** An in-memory store that records what was persisted, and when. */
class FakeStore implements LedgerStore {
  readonly written: Entry[] = [];
  /** Set to make a write hang, so we can observe ordering around the await. */
  gate: Promise<void> | undefined;

  async append(entry: Entry): Promise<void> {
    if (this.gate) await this.gate;
    this.written.push(entry);
  }
  async readAll(): Promise<Entry[]> {
    return [...this.written];
  }
}

const chain = (status: PaymentStatus = { found: false }): ChainReader => ({
  findPayment: async () => status,
});

const clock = (now = NOW): Clock => ({ now: () => now });

const open = (store: LedgerStore = new FakeStore()) =>
  Guard.open({ policy, policyHash: "sha256:test", store, chain: chain(), clock: clock() });

describe("THE test: two concurrent payments cannot both spend the same budget", () => {
  it("allows exactly one of two simultaneous payments that only one can afford", async () => {
    // Before Guard existed, evaluate() and hold() were separate calls, so this
    // exact code allowed BOTH — each evaluated against the same remaining
    // balance before either had reserved anything. The budget was breached by
    // the tool whose entire purpose is preventing that.
    //
    // This is the four-second test a reviewer writes in their head. It must pass.
    const store = new FakeStore();
    const guard = await open(store);

    // Spend $4.10 of the $5.00 daily cap. $0.90 remains.
    const first = await guard.authorize(quote("2.00"));
    await guard.confirm(first.holdId!, "0xa");
    const second = await guard.authorize(quote("2.00"));
    await guard.confirm(second.holdId!, "0xb");
    const third = await guard.authorize(quote("0.10"));
    await guard.confirm(third.holdId!, "0xc");

    // Two $0.80 payments, fired at once. The budget affords exactly one.
    const [a, b] = await Promise.all([
      guard.authorize(quote("0.80")),
      guard.authorize(quote("0.80")),
    ]);

    expect([a.decision, b.decision].sort()).toEqual(["allow", "deny"]);

    const denied = [a, b].find((v) => v.decision === "deny")!;
    expect(denied.verdict.reason).toBe("budget_exceeded");
    expect(denied.verdict.clause).toBe("budgets.daily-cap");
  });

  it("holds the budget even while the durable write is still in flight", async () => {
    // The hold must be visible to a concurrent authorize() the instant it is
    // placed — not after the disk write resolves. If the reservation only became
    // visible post-await, a payment racing the write would still see the old
    // balance.
    const store = new FakeStore();
    const guard = await open(store);

    let unblock!: () => void;
    store.gate = new Promise<void>((r) => (unblock = r));

    // This one will hang inside store.append(), after the hold is placed.
    const inFlight = guard.authorize(quote("2.00"));

    // Meanwhile, ask for more than the remaining budget allows.
    store.gate = undefined; // the second call's write may proceed
    const racer = await guard.authorize(quote("2.00"));
    const racer2 = await guard.authorize(quote("2.00"));

    unblock();
    await inFlight;

    // $2.00 x 3 = $6.00 against a $5.00 cap. The third must be denied, and the
    // first one's un-flushed hold must have counted.
    expect(racer.decision).toBe("allow");
    expect(racer2.decision).toBe("deny");
    expect(racer2.verdict.reason).toBe("budget_exceeded");
  });
});

describe("the split-purchase attack, end to end through a real ledger", () => {
  it("denies the third under-limit charge because the first two are remembered", async () => {
    // The headline claim, exercised through the whole stack rather than against
    // a hand-built Map: authorize -> hold -> persist -> authorize -> ...
    //
    // The agent wants $5.40 against a $5.00 cap. Each payment of $1.80 is under
    // the $2.00 per-payment limit, so x402's stateless hook — which can only
    // express a per-transaction cap — waves all three through.
    const guard = await open();

    const first = await guard.authorize(quote("1.80"));
    expect(first.decision).toBe("allow");
    await guard.confirm(first.holdId!, "0x1");

    const second = await guard.authorize(quote("1.80"));
    expect(second.decision).toBe("allow");
    await guard.confirm(second.holdId!, "0x2");

    const third = await guard.authorize(quote("1.80"));
    expect(third.decision).toBe("deny");
    expect(third.verdict.reason).toBe("budget_exceeded");
    expect(third.verdict.clause).toBe("budgets.daily-cap");
    expect(third.holdId).toBeUndefined(); // a denial reserves nothing
  });
});

describe("the hold is durable before the caller may spend", () => {
  it("does not resolve authorize() until the hold has actually been written", async () => {
    // A hold that exists only in memory is a hold a crash erases, and an erased
    // hold is budget the agent spends twice. This test fails if authorize()
    // stops awaiting the write: we block the store, and assert authorize() is
    // still pending — nothing has been written and the promise has not resolved.
    const store = new FakeStore();
    const guard = await open(store);

    let unblock!: () => void;
    store.gate = new Promise<void>((r) => (unblock = r));

    let resolved = false;
    const p = guard.authorize(quote("1.00")).then((r) => {
      resolved = true;
      return r;
    });

    await Promise.resolve(); // let a microtask turn pass
    expect(resolved).toBe(false);       // still awaiting the write
    expect(store.written).toHaveLength(0);

    unblock();
    const auth = await p;
    expect(resolved).toBe(true);
    expect(store.written).toHaveLength(1);
    expect(store.written[0]!.holdId).toBe(auth.holdId);
  });

  it("writes nothing on a denial", async () => {
    const store = new FakeStore();
    const guard = await open(store);

    await guard.authorize(quote("2.01")); // over the per-payment cap
    expect(store.written).toHaveLength(0);
  });

  it("survives a restart with the budget intact", async () => {
    const store = new FakeStore();
    const first = await open(store);
    const auth = await first.authorize(quote("2.00"));
    await first.confirm(auth.holdId!, "0xabc");

    // Process dies. New Guard, same store.
    const restarted = await open(store);
    const next = await restarted.authorize(quote("2.00"));
    const overBudget = await restarted.authorize(quote("2.00"));

    expect(next.decision).toBe("allow");
    expect(overBudget.decision).toBe("deny"); // $6.00 > $5.00 cap, remembered
    expect(overBudget.verdict.reason).toBe("budget_exceeded");
  });
});

describe("an authorization binds to exactly one hold", () => {
  it("refuses a second authorization on the same hold", async () => {
    // Without this: sign a real authorization, broadcast it, then attach a fresh
    // UNUSED nonce. The sweep queries the second nonce, the chain truthfully
    // answers 'never used', and the hold is released. The chain told the truth;
    // we asked the wrong question.
    const guard = await open();
    const auth = await guard.authorize(quote("1.00"));

    await guard.attachAuthorization(auth.holdId!, `0x${"11".repeat(32)}`, SELLER, NOW + 60 * 60 * 1000);

    await expect(
      guard.attachAuthorization(auth.holdId!, `0x${"22".repeat(32)}`, SELLER, NOW + 60 * 60 * 1000),
    ).rejects.toThrow(/already carries authorization/);
  });
});

describe("a hold the chain could not resolve is retried, not stranded", () => {
  it("re-asks the chain on a later sweep instead of leaving a zombie forever", async () => {
    // One transient RPC blip must not permanently convert a hold into budget
    // that can never be recovered.
    const store = new FakeStore();
    let answer: PaymentStatus = { found: "unknown", reason: "RPC timeout" };

    const guard = await Guard.open({
      policy,
      policyHash: "sha256:test",
      store,
      chain: { findPayment: async () => answer },
      clock: clock(NOW),
      staleAfterMs: 0, // everything is immediately stale, for the test
    });

    const auth = await guard.authorize(quote("2.00"));
    await guard.attachAuthorization(auth.holdId!, `0x${"ab".repeat(32)}`, SELLER, NOW + 60 * 60 * 1000);

    const firstSweep = await guard.reconcile();
    expect(firstSweep[0]!.outcome).toBe("indeterminate");
    expect(guard.needsReconciliation()).toHaveLength(1);

    // The RPC comes back.
    answer = { found: true, transaction: "0xrecovered" };
    const secondSweep = await guard.reconcile();

    expect(secondSweep[0]!.outcome).toBe("settled");
    expect(guard.needsReconciliation()).toHaveLength(0);
  });
});

describe("an explicit undefined option does not disable the feature it configures", () => {
  it("falls back to the default staleAfterMs — the sweep still runs", async () => {
    // A JS caller (or a value read from JSON config) can pass staleAfterMs:
    // undefined. If the defaults are spread BEFORE opts, that undefined
    // overwrites the default, staleHolds compares against NaN, nothing is ever
    // stale, and reconcile() silently no-ops — the headline feature, off.
    const store = new FakeStore();
    let now = NOW;
    const guard = await Guard.open({
      policy,
      policyHash: "sha256:test",
      store,
      chain: chain({ found: true, transaction: "0xsettled" }),
      clock: { now: () => now },
      staleAfterMs: undefined,
    } as unknown as Parameters<typeof Guard.open>[0]);

    const auth = await guard.authorize(quote("2.00"));
    await guard.attachAuthorization(auth.holdId!, `0x${"cd".repeat(32)}`, SELLER, NOW + 60 * 60 * 1000);

    now = NOW + 11 * 60 * 1000; // past the 10-min default; NaN would never be stale

    const swept = await guard.reconcile();
    expect(swept).toHaveLength(1); // default applied, hold went stale and was swept
    expect(swept[0]!.outcome).toBe("settled");
  });
});

describe("restore does not reuse hold ids", () => {
  it("keeps the counter ahead of anything already in the log", async () => {
    const store = new FakeStore();
    const guard = await open(store);
    await guard.authorize(quote("1.00"));

    const restarted = await open(store);
    const next = await restarted.authorize(quote("1.00"));

    expect(next.holdId).toBe("hold-2"); // not hold-1 again
    expect(Ledger.restore(await store.readAll()).history()).toHaveLength(2);
  });
});

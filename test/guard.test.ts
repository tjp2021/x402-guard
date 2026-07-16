import { describe, expect, it } from "vitest";
import { AuthorityExposureError, Guard, GuardFaultError } from "../src/guard.js";
import { loadPolicy } from "../src/load.js";
import { SETTLEMENT_PROFILE } from "../src/policy.js";
import type { Quote } from "../src/policy.js";
import type { ChainReader } from "../src/ports.js";
import {
  MemoryStore,
  NONCE,
  NOW,
  PAYER,
  TX,
  TestChain,
  TestClock,
  finalizedBlock,
  loadedPolicy,
  policyDocument,
  quote,
} from "./core-fixtures.js";

class GateStore extends MemoryStore {
  gate?: Promise<void>;
  entered?: () => void;

  override async append(entry: Parameters<MemoryStore["append"]>[0]): Promise<void> {
    this.entered?.();
    if (this.gate) await this.gate;
    await super.append(entry);
  }
}

async function open(options: {
  store?: MemoryStore;
  chain?: TestChain;
  clock?: TestClock;
} = {}) {
  return Guard.open({
    loadedPolicy: loadedPolicy(),
    store: options.store ?? new MemoryStore(),
    chain: options.chain ?? new TestChain(),
    clock: options.clock ?? new TestClock(),
  });
}

function tightLoadedPolicy() {
  const document = policyDocument() as ReturnType<typeof policyDocument> & {
    payments: { max_per_payment: string; require_approval_over: string };
    budgets: Array<{ name: string; window: string; limit: string }>;
  };
  document.payments.max_per_payment = "2.00";
  document.payments.require_approval_over = "2.00";
  document.budgets[0]!.limit = "5.00";
  document.budgets[1]!.limit = "5.00";
  return loadPolicy(document, NOW);
}

describe("serialized authorization and durability", () => {
  it("allows one concurrent signing flight, then enforces budget after it resolves", async () => {
    const guard = await Guard.open({
      loadedPolicy: tightLoadedPolicy(),
      store: new MemoryStore(),
      chain: new TestChain(),
      clock: new TestClock(),
    });
    for (const amount of [1_800_000n, 1_800_000n, 600_000n]) {
      const authorization = await guard.authorize(quote(amount));
      if (authorization.decision !== "allow") throw new Error("expected allowed setup hold");
      await guard.markCreationIndeterminate(
        authorization.holdId,
        "creation_outcome_unknown",
      );
    }

    const attempts = await Promise.allSettled([
      guard.authorize(quote(800_000n)),
      guard.authorize(quote(800_000n)),
    ]);
    const allowed = attempts.find((attempt) => attempt.status === "fulfilled");
    const blocked = attempts.find((attempt) => attempt.status === "rejected");
    if (!allowed || allowed.status !== "fulfilled" || allowed.value.decision !== "allow") {
      throw new Error("expected one allowed signing flight");
    }
    expect(blocked).toMatchObject({ status: "rejected" });
    if (!blocked || blocked.status !== "rejected") throw new Error("expected blocked flight");
    expect(blocked.reason).toBeInstanceOf(AuthorityExposureError);

    await guard.markCreationIndeterminate(
      allowed.value.holdId,
      "creation_outcome_unknown",
    );
    const denied = await guard.authorize(quote(800_000n));
    expect(denied.decision).toBe("deny");
    expect(denied.verdict.reason).toBe("budget_exceeded");
    expect(guard.history()).toHaveLength(8);
  });

  it("does not grant authority or apply a hold before append resolves", async () => {
    const store = new GateStore();
    const guard = await Guard.open({
      loadedPolicy: loadedPolicy(),
      store,
      chain: new TestChain(),
      clock: new TestClock(),
    });
    let release!: () => void;
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => { entered = resolve; });
    store.entered = entered;
    store.gate = new Promise<void>((resolve) => { release = resolve; });
    let resolved = false;

    const pending = guard.authorize(quote()).then((value) => {
      resolved = true;
      return value;
    });
    await didEnter;
    expect(resolved).toBe(false);
    expect(store.entries).toHaveLength(0);
    expect(guard.history()).toHaveLength(0);

    release();
    const authorization = await pending;
    expect(authorization.decision).toBe("allow");
    expect(store.entries).toHaveLength(1);
    expect(guard.history()).toHaveLength(1);
  });

  it("faults closed on append failure without applying the proposed authorization", async () => {
    const store = new MemoryStore();
    const guard = await open({ store });
    const authorization = await guard.authorize(quote());
    expect(authorization.decision).toBe("allow");
    store.failNextAppend = true;

    await expect(
      guard.attachAuthorization(authorization.holdId!, NONCE, PAYER, 1n),
    ).rejects.toBeInstanceOf(GuardFaultError);
    expect(guard.isFaulted()).toBe(true);
    expect(store.entries).toHaveLength(1);
    expect(guard.history()).toHaveLength(1);
    expect(guard.history()[0]!.status).toBe("held");
    await expect(guard.authorize(quote())).rejects.toBeInstanceOf(GuardFaultError);
  });

  it("reopens a failed exposure append as a still-blocking held signing gap", async () => {
    const store = new MemoryStore();
    const guard = await open({ store });
    const authorization = await guard.authorize(quote());
    if (authorization.decision !== "allow") throw new Error("expected allowed fixture");
    store.failNextAppend = true;

    await expect(
      guard.markCreationIndeterminate(authorization.holdId, "authorization_unreadable"),
    ).rejects.toBeInstanceOf(GuardFaultError);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]!.status).toBe("held");

    const reopened = await open({ store });
    expect(reopened.history()).toHaveLength(1);
    expect(reopened.history()[0]!.status).toBe("held");
    await expect(reopened.authorize(quote())).rejects.toBeInstanceOf(
      AuthorityExposureError,
    );
  });

  it("rejects an invalid proposal before append and does not fault the Guard", async () => {
    const store = new MemoryStore();
    const guard = await open({ store });
    const authorization = await guard.authorize(quote());
    const before = store.appendCalls;

    await expect(
      guard.attachAuthorization(authorization.holdId!, "0x01", PAYER, 1n),
    ).rejects.toThrow(/nonce/);
    expect(store.appendCalls).toBe(before);
    expect(guard.isFaulted()).toBe(false);
    await expect(guard.authorize(quote())).rejects.toBeInstanceOf(AuthorityExposureError);
  });
});

describe("immutable trust boundaries", () => {
  it("rejects a forged LoadedPolicy, wrong profile, and failed readiness proof", async () => {
    const genuine = loadedPolicy();
    await expect(Guard.open({
      loadedPolicy: { policy: genuine.policy, hash: genuine.hash } as never,
      store: new MemoryStore(),
      chain: new TestChain(),
      clock: new TestClock(),
    })).rejects.toThrow(/opaque LoadedPolicy/);

    const wrongChain: ChainReader = {
      profile: { ...SETTLEMENT_PROFILE, chainId: 1 },
      assertReady: async () => {},
      findPayment: async () => ({ state: "unknown", reason: "wrong_chain" }),
    };
    await expect(Guard.open({
      loadedPolicy: genuine,
      store: new MemoryStore(),
      chain: wrongChain,
      clock: new TestClock(),
    })).rejects.toThrow(/matching Base Sepolia/);

    const unavailable = new TestChain();
    unavailable.ready = false;
    await expect(Guard.open({
      loadedPolicy: genuine,
      store: new MemoryStore(),
      chain: unavailable,
      clock: new TestClock(),
    })).rejects.toThrow("chain reader failed its readiness proof");
  });

  it("snapshots a quote synchronously and returns frozen detached evidence", async () => {
    const guard = await open();
    const source = { ...quote() };
    const pending = guard.authorize(source);
    source.amount = 9_000_000n;
    source.payTo = PAYER;
    source.resource = "https://attacker.test/changed";

    const authorization = await pending;
    expect(authorization.decision).toBe("allow");
    expect(authorization.verdict.quote.amount).toBe(1_000_000n);
    expect(authorization.verdict.quote.payTo).toBe(quote().payTo.toLowerCase());
    expect(guard.history()[0]!.amount).toBe(1_000_000n);
    expect(Object.isFrozen(authorization)).toBe(true);
    expect(Object.isFrozen(authorization.verdict)).toBe(true);
    expect(Object.isFrozen(authorization.verdict.budgets)).toBe(true);
    expect(() => {
      (authorization.verdict.quote as { amount: bigint }).amount = 0n;
    }).toThrow();
    expect(guard.history()[0]!.amount).toBe(1_000_000n);
  });

  it("bounds direct-call amounts and UTF-8 resource bytes before hashing", async () => {
    const store = new MemoryStore();
    const guard = await open({ store });
    await expect(guard.authorize({ ...quote(), amount: 1n << 256n }))
      .rejects.toThrow(/uint256/);
    await expect(guard.authorize({ ...quote(), resource: "é".repeat(4_097) }))
      .rejects.toThrow(/8192 UTF-8 bytes/);
    expect(store.appendCalls).toBe(0);
    expect(guard.isFaulted()).toBe(false);
  });
});

describe("proof-only lifecycle", () => {
  it("records facilitator success as nonterminal until exact chain proof", async () => {
    const chain = new TestChain();
    chain.status = { state: "unknown", reason: "settlement_mismatch" };
    const guard = await open({ chain });
    const authorization = await guard.authorize(quote());
    await guard.attachAuthorization(
      authorization.holdId!,
      NONCE,
      PAYER,
      BigInt(Math.floor(NOW / 1000) + 60),
    );

    const outcome = await guard.reportSettlement(authorization.holdId!, TX);
    expect(outcome).toMatchObject({ outcome: "indeterminate", reason: "settlement_mismatch" });
    expect(guard.history().map((event) => event.status)).toEqual([
      "held",
      "authorization_attached",
      "settlement_reported",
      "reconciling",
      "indeterminate",
    ]);
    expect(guard.history().some((event) => event.status === "settled")).toBe(false);
  });

  it("reconciles every signed nonterminal hold during reopen", async () => {
    const store = new MemoryStore();
    const chain = new TestChain();
    const first = await open({ store, chain });
    const authorization = await first.authorize(quote());
    await first.attachAuthorization(
      authorization.holdId!,
      NONCE,
      PAYER,
      BigInt(Math.floor(NOW / 1000) + 60),
    );
    chain.status = {
      state: "settled",
      transaction: TX,
      settlementAt: NOW,
      finalizedBlock: finalizedBlock(BigInt(Math.floor(NOW / 1000) + 10)),
    };

    const restarted = await open({ store, chain });
    expect(restarted.history().at(-1)).toMatchObject({ status: "settled", transaction: TX });
    expect(chain.calls).toBe(1);
  });

  it("keeps an unresolved held signing lock across direct reconcile and reopen", async () => {
    const store = new MemoryStore();
    const first = await open({ store });
    const authorization = await first.authorize(quote());
    if (authorization.decision !== "allow") throw new Error("expected allowed fixture");

    await expect(first.reconcileHold(authorization.holdId)).resolves.toEqual({
      holdId: authorization.holdId,
      outcome: "indeterminate",
      reason: "creation_outcome_unknown",
    });
    expect(first.history()).toHaveLength(1);
    expect(first.history()[0]!.status).toBe("held");

    const reopened = await open({ store });
    expect(reopened.history()).toHaveLength(1);
    expect(reopened.history()[0]!.status).toBe("held");
    await expect(reopened.authorize(quote())).rejects.toBeInstanceOf(
      AuthorityExposureError,
    );
  });

  it.each(["creation_outcome_unknown", "authorization_unreadable"] as const)(
    "makes %s ambiguity irreversible instead of attaching a retry authorization",
    async (reason) => {
      const guard = await open();
      const authorization = await guard.authorize(quote());
      if (authorization.decision !== "allow") throw new Error("expected allowed fixture");
      await guard.markCreationIndeterminate(authorization.holdId, reason);

      await expect(
        guard.attachAuthorization(
          authorization.holdId,
          NONCE,
          PAYER,
          BigInt(Math.floor(NOW / 1000) + 60),
        ),
      ).rejects.toThrow(/indeterminate, cannot attach authorization/);

      expect(guard.history().at(-1)).toMatchObject({ status: "indeterminate", reason });
      expect(guard.history().some((entry) => entry.status === "released")).toBe(false);
      expect(guard.isFaulted()).toBe(false);
    },
  );

  it("reconciles known holds while an exposure latch blocks new authority after reopen", async () => {
    const store = new MemoryStore();
    const chain = new TestChain();
    const first = await open({ store, chain });
    const known = await first.authorize(quote());
    if (known.decision !== "allow") throw new Error("expected allowed known hold");
    await first.attachAuthorization(
      known.holdId,
      NONCE,
      PAYER,
      BigInt(Math.floor(NOW / 1000) + 60),
    );
    const exposed = await first.authorize(quote());
    if (exposed.decision !== "allow") throw new Error("expected allowed exposure hold");
    await first.markCreationIndeterminate(exposed.holdId, "authorization_unreadable");
    await expect(first.authorize(quote())).rejects.toBeInstanceOf(AuthorityExposureError);

    chain.status = {
      state: "settled",
      transaction: TX,
      settlementAt: NOW,
      finalizedBlock: finalizedBlock(BigInt(Math.floor(NOW / 1000) + 10)),
    };
    const reopened = await open({ store, chain });

    expect(reopened.history().filter((entry) => entry.status === "settled")).toHaveLength(1);
    expect(reopened.needsReconciliation()).toContainEqual(expect.objectContaining({
      holdId: exposed.holdId,
      status: "indeterminate",
      reason: "authorization_unreadable",
    }));
    await expect(reopened.authorize(quote())).rejects.toBeInstanceOf(AuthorityExposureError);
    expect(reopened.isFaulted()).toBe(false);
  });

  it("does not expose unsafe confirm or release primitives", async () => {
    const guard = await open();
    expect((guard as unknown as Record<string, unknown>)["confirm"]).toBeUndefined();
    expect((guard as unknown as Record<string, unknown>)["release"]).toBeUndefined();
    expect((guard as unknown as Record<string, unknown>)["abandon"]).toBeUndefined();
    expect((guard as unknown as Record<string, unknown>)["abandonUnsigned"]).toBeUndefined();
  });
});

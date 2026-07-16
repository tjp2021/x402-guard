import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.js";
import type { Entry } from "../src/ledger.js";
import { reconcileHold, sweep } from "../src/reconcile.js";
import type { ReconcileOptions } from "../src/reconcile.js";
import {
  NONCE,
  NOW,
  PAYER,
  TX,
  TestChain,
  TestClock,
  finalizedBlock,
  loadedPolicy,
  quote,
} from "./core-fixtures.js";

const loaded = loadedPolicy();
const deadline = BigInt(Math.floor(NOW / 1000) + 60);

function apply<T extends Entry>(ledger: Ledger, event: T): T {
  ledger.applyPersisted(event);
  return event;
}

function setup(signed = true) {
  const ledger = new Ledger();
  apply(ledger, ledger.proposeHold(quote(), loaded.hash, NOW));
  if (signed) {
    apply(
      ledger,
      ledger.proposeAttachAuthorization("hold-1", NONCE, PAYER, deadline, NOW + 1),
    );
  }
  const chain = new TestChain();
  const clock = new TestClock(NOW + 2);
  const commits: Entry[] = [];
  const opts: ReconcileOptions = {
    ledger,
    chain,
    clock,
    commit: async (event) => {
      commits.push(event);
      ledger.applyPersisted(event);
    },
  };
  return { ledger, chain, clock, commits, opts };
}

describe("proof-bearing reconciliation", () => {
  it("reconciles a fresh signed authorization immediately on restart", async () => {
    const { ledger, chain, opts } = setup();
    chain.status = {
      state: "settled",
      transaction: TX,
      settlementAt: NOW + 1,
      finalizedBlock: finalizedBlock(BigInt(Math.floor(NOW / 1000) + 10)),
    };

    const results = await sweep(opts);
    expect(results).toEqual([
      { holdId: "hold-1", outcome: "settled", reason: "settlement_verified" },
    ]);
    expect(ledger.state("hold-1")).toMatchObject({ status: "settled", transaction: TX });
    expect(chain.calls).toBe(1);
    expect(Object.isFrozen(results)).toBe(true);
    expect(Object.isFrozen(results[0])).toBe(true);
  });

  it("resumes a persisted settlement report but treats the hint as nonterminal", async () => {
    const { ledger, chain, opts } = setup();
    apply(
      ledger,
      ledger.proposeSettlementReported("hold-1", TX, NOW + 2),
    );
    chain.status = { state: "unknown", reason: "settlement_mismatch" };

    const [result] = await sweep(opts);
    expect(result).toEqual({
      holdId: "hold-1",
      outcome: "indeterminate",
      reason: "settlement_mismatch",
    });
    expect(ledger.state("hold-1")!.status).toBe("indeterminate");
    expect(ledger.committed(loaded.policy, NOW + 3).get("hourly")).toBe(1_000_000n);
  });

  it("releases signed authority only from finalized unused-after-expiry proof", async () => {
    const { ledger, chain, opts } = setup();
    chain.status = {
      state: "unused_expired",
      finalizedBlock: finalizedBlock(deadline + 1n),
    };

    const result = await reconcileHold("hold-1", opts);
    expect(result).toEqual({
      holdId: "hold-1",
      outcome: "released",
      reason: "authorization_unused_expired",
    });
    expect(ledger.state("hold-1")!.status).toBe("released");
    expect(ledger.committed(loaded.policy, NOW + 3).get("hourly")).toBe(0n);
  });

  it("never substitutes local wall time for finalized chain expiry", async () => {
    const { ledger, chain, clock, opts } = setup();
    clock.value = NOW + 30 * 24 * 60 * 60 * 1000;
    chain.status = { state: "unknown", reason: "authorization_still_live" };

    const result = await reconcileHold("hold-1", opts);
    expect(result.outcome).toBe("indeterminate");
    expect(result.reason).toBe("authorization_still_live");
    expect(ledger.committed(loaded.policy, clock.value).get("hourly")).toBe(1_000_000n);
  });

  it("rejects an early or malformed negative proof without releasing", async () => {
    const { ledger, chain, opts } = setup();
    chain.status = {
      state: "unused_expired",
      finalizedBlock: finalizedBlock(deadline),
    };

    const result = await reconcileHold("hold-1", opts);
    expect(result).toEqual({
      holdId: "hold-1",
      outcome: "indeterminate",
      reason: "malformed_query",
    });
    expect(ledger.state("hold-1")!.status).toBe("indeterminate");
  });

  it("normalizes thrown RPC failures and forged return objects to bounded codes", async () => {
    const first = setup();
    first.chain.findPayment = async () => {
      throw new Error("https://rpc.test/?api_key=must-not-persist");
    };
    expect(await reconcileHold("hold-1", first.opts)).toMatchObject({
      outcome: "indeterminate",
      reason: "rpc_unavailable",
    });
    expect(JSON.stringify(first.ledger.history(), bigintJson)).not.toContain("api_key");

    const second = setup();
    second.chain.status = Object.defineProperty({}, "state", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(await reconcileHold("hold-1", second.opts)).toMatchObject({
      outcome: "indeterminate",
      reason: "malformed_query",
    });
  });

  it("never auto-downgrades a stale held signing gap", async () => {
    const { ledger, chain, clock, commits, opts } = setup(false);
    clock.value = NOW + 10 * 60 * 1000;

    const results = await sweep(opts);
    expect(results).toEqual([]);
    expect(chain.calls).toBe(0);
    expect(ledger.state("hold-1")!.status).toBe("held");
    expect(ledger.blocksNewAuthority()).toBe(true);
    expect(ledger.committed(loaded.policy, clock.value).get("hourly")).toBe(1_000_000n);

    const direct = await reconcileHold("hold-1", opts);
    expect(direct).toEqual({
      holdId: "hold-1",
      outcome: "indeterminate",
      reason: "creation_outcome_unknown",
    });
    expect(ledger.history()).toHaveLength(1);
    expect(commits).toEqual([]);
    expect(ledger.state("hold-1")!.status).toBe("held");
    expect(ledger.blocksNewAuthority()).toBe(true);
  });
});

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

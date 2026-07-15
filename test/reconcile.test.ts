import { describe, it, expect } from "vitest";
import { Ledger } from "../src/ledger.js";
import { sweep } from "../src/reconcile.js";
import type { ChainReader, Clock, PaymentStatus } from "../src/ports.js";
import type { Policy, Quote } from "../src/policy.js";
import { parseDecimal } from "../src/amount.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NET = "eip155:84532";
const SELLER = "0xE5f6000000000000000000000000000000007788";
const PAYER = "0xA1b2000000000000000000000000000000001234";
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const MINUTE = 60 * 1000;
const STALE_AFTER = 10 * MINUTE;
const usd = (s: string) => parseDecimal(s, 6);

const policy: Policy = {
  name: "p",
  version: 1,
  asset: { symbol: "USDC", address: USDC, network: NET, decimals: 6 },
  mandate: { holder: "research-team", agent: "a", expires: Date.UTC(2026, 7, 1) },
  payees: [{ name: "Seller", address: SELLER }],
  payments: { maxPerPayment: usd("2.00"), requireApprovalOver: usd("10.00") },
  budgets: [{ name: "daily-cap", window: "rolling-24h", limit: usd("5.00") }],
  velocity: { maxPaymentsPerHour: 10 },
};

const quote = (amount = "1.80"): Quote => ({
  amount: usd(amount),
  asset: USDC,
  network: NET,
  payTo: SELLER,
  resource: "https://api.example/report",
});

const clock = (now: number): Clock => ({ now: () => now });

/** A chain that answers however the test needs. */
const chainSaying = (status: PaymentStatus): ChainReader => ({
  findPayment: async () => status,
});

const chainThatThrows = (msg: string): ChainReader => ({
  findPayment: async () => {
    throw new Error(msg);
  },
});

/** A hold that was placed, signed, and then went quiet. */
function orphanedHold(): Ledger {
  const l = new Ledger();
  l.hold(quote(), NOW);
  l.attachAuthorization("hold-1", "0xnonce1", PAYER, NOW + 60 * 60 * 1000);
  return l;
}

const committed = (l: Ledger, now = NOW + STALE_AFTER) =>
  l.committed(policy, now).get("daily-cap");

describe("a payment that goes quiet is looked up, not guessed at", () => {
  it("settles the hold when the chain confirms the payment happened", () => {
    return (async () => {
      const l = orphanedHold();
      const results = await sweep({
        ledger: l,
        chain: chainSaying({ found: true, transaction: "0xdeadbeef" }),
        clock: clock(NOW + STALE_AFTER),
        staleAfterMs: STALE_AFTER,
      });

      expect(results[0]!.outcome).toBe("settled");
      expect(committed(l)).toBe(usd("1.80")); // real spend, still consumes budget
      expect(l.history().at(-1)!.transaction).toBe("0xdeadbeef");
      expect(l.needsReconciliation()).toHaveLength(0);
    })();
  });

  it("REFUSES to release while the signed authorization can still be submitted", async () => {
    // The bug this closes: an EIP-3009 authorization is a signed bearer
    // instrument. "Not on chain yet" is not "never will be" — the facilitator
    // can still submit it until validBefore (x402 #2821 is a 9h delay). Release
    // now and the agent respends while the original is still landable; both
    // settle. So a 'not found' before the deadline holds, it does not release.
    const l = orphanedHold(); // validBefore = NOW + 1h
    const results = await sweep({
      ledger: l,
      chain: chainSaying({ found: false }),
      clock: clock(NOW + STALE_AFTER), // 10 min < 1h deadline
      staleAfterMs: STALE_AFTER,
    });

    expect(results[0]!.outcome).toBe("indeterminate");
    expect(committed(l)).toBe(usd("1.80")); // budget stays held — payment can still land
  });

  it("releases only once the authorization can no longer be submitted", async () => {
    // Past validBefore the transfer would revert on-chain, so 'not found' is now
    // permanent. This is the only safe release for a lost payment, and it is
    // safe because it is evidence, not a timeout heuristic.
    const l = orphanedHold(); // validBefore = NOW + 1h
    const past = NOW + 2 * 60 * 60 * 1000; // 2h > 1h deadline
    const results = await sweep({
      ledger: l,
      chain: chainSaying({ found: false }),
      clock: clock(past),
      staleAfterMs: STALE_AFTER,
    });

    expect(results[0]!.outcome).toBe("released");
    expect(l.committed(policy, past).get("daily-cap")).toBe(0n); // handed back on proof
  });

  it("NEVER releases when the chain cannot answer — the hold stays committed", async () => {
    // The dangerous case. An unreachable RPC is not evidence that the payment
    // failed. Handing the budget back here is how an agent spends the same
    // money twice.
    const l = orphanedHold();
    const results = await sweep({
      ledger: l,
      chain: chainSaying({ found: "unknown", reason: "RPC timeout" }),
      clock: clock(NOW + STALE_AFTER),
      staleAfterMs: STALE_AFTER,
    });

    expect(results[0]!.outcome).toBe("indeterminate");
    expect(committed(l)).toBe(usd("1.80")); // wrong in the SAFE direction
    expect(l.needsReconciliation()).toHaveLength(1);
  });

  it("treats a thrown RPC error as 'cannot answer', not as 'did not happen'", async () => {
    const l = orphanedHold();
    const results = await sweep({
      ledger: l,
      chain: chainThatThrows("ECONNREFUSED"),
      clock: clock(NOW + STALE_AFTER),
      staleAfterMs: STALE_AFTER,
    });

    expect(results[0]!.outcome).toBe("indeterminate");
    expect(results[0]!.detail).toContain("ECONNREFUSED");
    expect(committed(l)).toBe(usd("1.80")); // still held
  });
});

describe("a hold with no recorded authorization is NOT auto-released", () => {
  it("flags for a human instead of releasing — a payload may have been signed", async () => {
    // The bug this closes: attachAuthorization runs AFTER the payload is signed,
    // so a crash in the sign→attach window leaves a nonce-less hold with a live
    // bearer authorization the facilitator can still submit. Releasing it (the
    // old behavior, claiming "nothing could have settled") frees budget for a
    // payment that can still land — the double-spend, relocated.
    const l = new Ledger();
    l.hold(quote(), NOW); // no attachAuthorization

    let asked = false;
    const chain: ChainReader = {
      findPayment: async () => {
        asked = true;
        return { found: false };
      },
    };

    const results = await sweep({
      ledger: l,
      chain,
      clock: clock(NOW + STALE_AFTER),
      staleAfterMs: STALE_AFTER,
    });

    expect(asked).toBe(false); // no nonce to query
    expect(results[0]!.outcome).toBe("indeterminate"); // NOT released
    expect(committed(l)).toBe(usd("1.80")); // budget stays held — cannot prove no money moved
  });

  it("is released only when the caller AFFIRMS it was never signed, via abandon()", async () => {
    // The one safe release for a nonce-less hold: the caller is the party that
    // knows no payload was created. abandon() is that affirmation.
    const l = new Ledger();
    l.hold(quote(), NOW);
    l.abandon("hold-1", "agent decided not to buy; no payload was signed");
    expect(committed(l)).toBe(0n);
  });

  it("refuses to abandon a hold that already carries an authorization", async () => {
    // Once a payload is signed, the money can still land — only the chain can
    // resolve it, never the caller's word.
    const l = new Ledger();
    l.hold(quote(), NOW);
    l.attachAuthorization("hold-1", "0xnonce1", PAYER, NOW + 60 * 60 * 1000);
    expect(() => l.abandon("hold-1", "changed my mind")).toThrow(/reconcile against the chain/);
  });
});

describe("the sweep is safe to run repeatedly", () => {
  it("leaves fresh holds alone", async () => {
    const l = orphanedHold();
    const results = await sweep({
      ledger: l,
      chain: chainSaying({ found: false }),
      clock: clock(NOW + MINUTE), // only a minute old, not stale yet
      staleAfterMs: STALE_AFTER,
    });

    expect(results).toHaveLength(0);
    expect(committed(l, NOW + MINUTE)).toBe(usd("1.80")); // still held, correctly
  });

  it("resumes a hold left mid-lookup by a crash", async () => {
    // The process died between marking 'reconciling' and getting an answer. On
    // restart the hold is neither fresh nor resolved — the sweep must pick it
    // back up rather than ignore it forever.
    const l = orphanedHold();
    l.reconciling("hold-1", "went quiet; asking the chain");
    // ...crash...

    const results = await sweep({
      ledger: l,
      chain: chainSaying({ found: true, transaction: "0xabc" }),
      clock: clock(NOW + STALE_AFTER),
      staleAfterMs: STALE_AFTER,
    });

    expect(results[0]!.outcome).toBe("settled");
  });

  it("does not re-sweep a hold it already resolved", async () => {
    const l = orphanedHold();
    const opts = {
      ledger: l,
      chain: chainSaying({ found: true, transaction: "0xabc" }),
      clock: clock(NOW + STALE_AFTER),
      staleAfterMs: STALE_AFTER,
    };

    expect(await sweep(opts)).toHaveLength(1);
    expect(await sweep(opts)).toHaveLength(0); // settled holds are not stale holds
  });
});

describe("crash recovery", () => {
  it("rebuilds state from the durable log, and does not reuse hold ids", () => {
    const original = orphanedHold();
    original.confirm("hold-1", "0xabc");

    const restored = Ledger.restore(original.history());

    expect(restored.committed(policy, NOW).get("daily-cap")).toBe(usd("1.80"));

    // A fresh hold after restore must not collide with hold-1, or it would
    // silently overwrite that hold's state.
    const next = restored.hold(quote("0.50"), NOW);
    expect(next.holdId).toBe("hold-2");
    expect(restored.committed(policy, NOW).get("daily-cap")).toBe(usd("2.30"));
  });
});

import { describe, expect, it } from "vitest";
import { Ledger, LedgerError } from "../src/ledger.js";
import type { Entry } from "../src/ledger.js";
import {
  NONCE,
  NOW,
  PAYER,
  TX,
  finalizedBlock,
  loadedPolicy,
  quote,
} from "./core-fixtures.js";

const loaded = loadedPolicy();
const deadline = BigInt(Math.floor(NOW / 1000) + 60);

function apply<T extends Entry>(ledger: Ledger, entry: T): T {
  ledger.applyPersisted(entry);
  return entry;
}

function hold(ledger: Ledger, amount = 1_000_000n, at = NOW) {
  return apply(ledger, ledger.proposeHold(quote(amount), loaded.hash, at));
}

function sign(ledger: Ledger, at = NOW + 1) {
  return apply(
    ledger,
    ledger.proposeAttachAuthorization("hold-1", NONCE, PAYER, deadline, at),
  );
}

function beginReconcile(ledger: Ledger, at = NOW + 2) {
  return apply(ledger, ledger.proposeReconciling("hold-1", at));
}

describe("proposal, persistence, and immutable evidence", () => {
  it("keeps a proposed hold inert until it is durably applied", () => {
    const ledger = new Ledger();
    const proposed = ledger.proposeHold(quote(), loaded.hash, NOW);

    expect(ledger.history()).toHaveLength(0);
    expect(ledger.committed(loaded.policy, NOW).get("hourly")).toBe(0n);

    ledger.applyPersisted(proposed);
    expect(ledger.history()).toHaveLength(1);
    expect(ledger.committed(loaded.policy, NOW).get("hourly")).toBe(1_000_000n);
  });

  it("hashes resources once and returns frozen detached history", () => {
    const ledger = new Ledger();
    const source = { ...quote(), resource: "https://seller.test/private/path" };
    apply(ledger, ledger.proposeHold(source, loaded.hash, NOW));
    source.resource = "https://attacker.test/changed";

    const history = ledger.history();
    expect(history[0]!.quote).not.toHaveProperty("resource");
    expect(history[0]!.quote.resourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(history, bigintJson)).not.toContain("private/path");
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history[0])).toBe(true);
    expect(Object.isFrozen(history[0]!.quote)).toBe(true);
    expect(() => {
      (history[0]!.quote as { payTo: string }).payTo = PAYER;
    }).toThrow();
    expect(ledger.state("hold-1")!.quote.payTo).toBe(quote().payTo);
  });

  it("clones custom-store entries before making them authoritative", () => {
    const sourceLedger = new Ledger();
    const original = sourceLedger.proposeHold(quote(), loaded.hash, NOW);
    const mutable = { ...original, quote: { ...original.quote } } as Entry;
    const restored = Ledger.restore([mutable]);

    (mutable as { amount: bigint }).amount = 9_000_000n;
    (mutable.quote as { resourceHash: string }).resourceHash = `sha256:${"f".repeat(64)}`;

    expect(restored.state("hold-1")!.amount).toBe(1_000_000n);
    expect(restored.state("hold-1")!.quote.resourceHash).not.toBe(
      `sha256:${"f".repeat(64)}`,
    );
  });
});

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

describe("strict versioned lifecycle", () => {
  it("rejects forged status/reason/field combinations at runtime", () => {
    const source = new Ledger();
    const valid = source.proposeHold(quote(), loaded.hash, NOW);
    const forgedHeld = {
      ...valid,
      nonce: NONCE,
      payer: PAYER,
      validBefore: deadline,
    } as unknown as Entry;
    const partialIndeterminate = {
      ...valid,
      status: "indeterminate",
      reason: "creation_outcome_unknown",
      nonce: NONCE,
    } as unknown as Entry;
    const wrongReason = {
      ...valid,
      status: "released",
      reason: "settlement_verified",
    } as unknown as Entry;

    expect(() => new Ledger().applyPersisted(forgedHeld)).toThrow(/unexpected or missing/);
    expect(() => new Ledger().applyPersisted(partialIndeterminate)).toThrow(/present together/);
    expect(() => new Ledger().applyPersisted(wrongReason)).toThrow(/invalid reason/);
  });

  it("rejects chain-only reasons on unsigned holds and impossible transitions", () => {
    const ledger = new Ledger();
    hold(ledger);
    const forged = {
      ...ledger.state("hold-1")!,
      status: "indeterminate",
      reason: "rpc_unavailable",
      eventAt: NOW + 1,
    } as unknown as Entry;

    expect(() => ledger.applyPersisted(forged)).toThrow(/chain-only/);
    expect(() =>
      ledger.proposeSettled(
        "hold-1",
        {
          state: "settled",
          transaction: TX,
          settlementAt: NOW + 2,
          finalizedBlock: finalizedBlock(BigInt(Math.floor(NOW / 1000) + 10)),
        },
        NOW + 2,
      ),
    ).toThrow(/no recorded signed authorization/);
  });

  it("rejects oversized hold IDs, uint256 overflow, and fact drift on replay", () => {
    const source = new Ledger();
    const valid = source.proposeHold(quote(), loaded.hash, NOW);
    expect(() => new Ledger().applyPersisted({
      ...valid,
      holdId: "hold-9007199254740992",
    } as Entry)).toThrow(/safe integer/);
    expect(() => new Ledger().applyPersisted({
      ...valid,
      amount: 1n << 256n,
      quote: { ...valid.quote, amount: 1n << 256n },
    } as Entry)).toThrow(/uint256/);

    const ledger = new Ledger();
    apply(ledger, valid);
    const attached = ledger.proposeAttachAuthorization(
      "hold-1",
      NONCE,
      PAYER,
      deadline,
      NOW + 1,
    );
    expect(() => ledger.applyPersisted({
      ...attached,
      policyHash: `sha256:${"f".repeat(64)}`,
    })).toThrow(/facts changed/);
  });

  it("preserves bigint authorization deadlines losslessly", () => {
    const ledger = new Ledger();
    hold(ledger);
    const large = (1n << 200n) + 123n;
    const attached = apply(
      ledger,
      ledger.proposeAttachAuthorization("hold-1", NONCE, PAYER, large, NOW + 1),
    );
    expect(attached.validBefore).toBe(large);
    expect(ledger.state("hold-1")!.status).toBe("authorization_attached");
    expect((ledger.state("hold-1") as typeof attached).validBefore).toBe(large);
  });

  it("preserves an authority-exposure latch against replay, retry, and terminal forgery", () => {
    const ledger = new Ledger();
    const held = hold(ledger);
    const exposed = apply(
      ledger,
      ledger.proposeIndeterminate(
        held.holdId,
        "authorization_unreadable",
        NOW + 1,
      ),
    );
    expect(ledger.blocksNewAuthority()).toBe(true);
    expect(() =>
      ledger.proposeAttachAuthorization(
        held.holdId,
        NONCE,
        PAYER,
        deadline,
        NOW + 2,
      ),
    ).toThrow(/indeterminate, cannot attach authorization/);

    const downgraded = {
      ...exposed,
      reason: "creation_outcome_unknown",
      eventAt: NOW + 2,
    } as unknown as Entry;
    const forgedRelease = {
      ...exposed,
      status: "released",
      reason: "authorization_unused_expired",
      eventAt: NOW + 2,
      nonce: NONCE,
      payer: PAYER,
      validBefore: deadline,
      finalizedBlock: finalizedBlock(deadline + 1n),
    } as unknown as Entry;

    expect(() => ledger.applyPersisted(downgraded)).toThrow(/irreversible authority-exposure/);
    expect(() => ledger.applyPersisted(forgedRelease)).toThrow(/irreversible authority-exposure/);
    expect(ledger.state(held.holdId)).toMatchObject({
      status: "indeterminate",
      reason: "authorization_unreadable",
    });
    expect(() => Ledger.restore([held, exposed, downgraded])).toThrow(
      /irreversible authority-exposure/,
    );
  });
});

describe("proof-only terminal states and budget timing", () => {
  it("requires finalized expiry proof to release signed authority", () => {
    const ledger = new Ledger();
    hold(ledger);
    sign(ledger);
    beginReconcile(ledger);

    expect(() => ledger.proposeReleasedUnused(
      "hold-1",
      { state: "unused_expired", finalizedBlock: finalizedBlock(deadline) },
      NOW + 3,
    )).toThrow(/strictly past/);

    apply(
      ledger,
      ledger.proposeReleasedUnused(
        "hold-1",
        { state: "unused_expired", finalizedBlock: finalizedBlock(deadline + 1n) },
        NOW + 3,
      ),
    );
    expect(ledger.state("hold-1")!.status).toBe("released");
    expect(ledger.committed(loaded.policy, NOW + 3).get("hourly")).toBe(0n);
  });

  it("rejects proof-free release events and keeps unsigned holds committed", () => {
    const ledger = new Ledger();
    hold(ledger);
    const forged = {
      ...ledger.state("hold-1")!,
      status: "released",
      reason: "caller_attests_unsigned",
      eventAt: NOW + 1,
    } as unknown as Entry;

    expect(() => ledger.applyPersisted(forged)).toThrow(/invalid reason/);
    expect(ledger.state("hold-1")!.status).toBe("held");
    expect(ledger.committed(loaded.policy, NOW + 1).get("hourly")).toBe(1_000_000n);
  });

  it("never ages unresolved authority out of any rolling budget", () => {
    const ledger = new Ledger();
    hold(ledger);
    sign(ledger);
    const muchLater = NOW + 8 * 24 * 60 * 60 * 1000;
    expect(ledger.committed(loaded.policy, muchLater).get("hourly")).toBe(1_000_000n);
    expect(ledger.committed(loaded.policy, muchLater).get("daily")).toBe(1_000_000n);
  });

  it("ages verified spend from settlement time, not hold time", () => {
    const ledger = new Ledger();
    const oldHold = NOW - 2 * 60 * 60 * 1000;
    hold(ledger, 1_000_000n, oldHold);
    sign(ledger, NOW - 100);
    beginReconcile(ledger, NOW - 50);
    apply(
      ledger,
      ledger.proposeSettled(
        "hold-1",
        {
          state: "settled",
          transaction: TX,
          settlementAt: NOW,
          finalizedBlock: finalizedBlock(BigInt(Math.floor(NOW / 1000) + 1)),
        },
        NOW + 1,
      ),
    );

    expect(ledger.committed(loaded.policy, NOW + 59 * 60 * 1000).get("hourly"))
      .toBe(1_000_000n);
    expect(ledger.committed(loaded.policy, NOW + 61 * 60 * 1000).get("hourly"))
      .toBe(0n);
    expect(ledger.committed(loaded.policy, NOW + 61 * 60 * 1000).get("daily"))
      .toBe(1_000_000n);
  });
});

import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlLedgerStore } from "../src/adapters/jsonl-store.js";
import { Ledger, type Entry, type HeldEntry } from "../src/ledger.js";
import { SETTLEMENT_PROFILE, type Quote } from "../src/policy.js";

const run = promisify(execFile);
const SELLER = "0xE5f6000000000000000000000000000000007788";
const PAYER = "0xA11cE00000000000000000000000000000000000";
const NONCE = `0x${"12".repeat(32)}`;
const TRANSACTION = `0x${"34".repeat(32)}`;
const BLOCK_HASH = `0x${"56".repeat(32)}`;
const POLICY_HASH = `sha256:${"78".repeat(32)}`;
const NOW = Date.UTC(2026, 6, 16, 12, 0, 0);
const VALID_BEFORE = BigInt(Math.floor(NOW / 1000) + 3_600);

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "x402-guard-jsonl-"));
  path = join(dir, "ledger.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function quote(amount = 1_800_000n): Quote {
  return {
    amount,
    asset: SETTLEMENT_PROFILE.asset,
    network: SETTLEMENT_PROFILE.network,
    payTo: SELLER,
    resource: "https://service.example/private/report?view=summary",
  };
}

function held(amount = 1_800_000n): { ledger: Ledger; entry: HeldEntry } {
  const ledger = new Ledger();
  const entry = ledger.proposeHold(quote(amount), POLICY_HASH, NOW);
  ledger.applyPersisted(entry);
  return { ledger, entry };
}

function authorizedLifecycle(amount = 1_800_000n): Entry[] {
  const { ledger, entry } = held(amount);
  const attached = ledger.proposeAttachAuthorization(
    entry.holdId,
    NONCE,
    PAYER,
    VALID_BEFORE,
    NOW + 1,
  );
  ledger.applyPersisted(attached);
  const reported = ledger.proposeSettlementReported(
    entry.holdId,
    TRANSACTION,
    NOW + 2,
  );
  ledger.applyPersisted(reported);
  const reconciling = ledger.proposeReconciling(entry.holdId, NOW + 3);
  ledger.applyPersisted(reconciling);
  const settled = ledger.proposeSettled(
    entry.holdId,
    {
      state: "settled",
      transaction: TRANSACTION,
      settlementAt: NOW + 3_000,
      finalizedBlock: {
        chainId: SETTLEMENT_PROFILE.chainId,
        number: 9_007_199_254_740_993n,
        hash: BLOCK_HASH,
        timestamp: BigInt(Math.floor(NOW / 1000) + 3),
      },
    },
    NOW + 4_000,
  );
  ledger.applyPersisted(settled);
  return [...ledger.history()];
}

async function persist(entries: readonly Entry[]): Promise<void> {
  const store = new JsonlLedgerStore(path);
  for (const entry of entries) await store.append(entry);
}

async function wireLines(): Promise<Record<string, unknown>[]> {
  return (await readFile(path, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function rewriteWire(lines: readonly Record<string, unknown>[]): Promise<void> {
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

async function oneHeldWire(): Promise<Record<string, unknown>> {
  await persist([held().entry]);
  return (await wireLines())[0]!;
}

describe("versioned, private evidence", () => {
  it("round-trips a complete lifecycle without lossy integers", async () => {
    const lifecycle = authorizedLifecycle(9_007_199_254_740_993n);
    await persist(lifecycle);

    const restored = await new JsonlLedgerStore(path).readAll();

    expect(restored).toHaveLength(5);
    const latest = restored.at(-1)!;
    expect(latest.status).toBe("settled");
    if (latest.status !== "settled") throw new Error("expected settled fixture");
    expect(latest.amount).toBe(9_007_199_254_740_993n);
    expect(latest.validBefore).toBe(VALID_BEFORE);
    expect(latest.finalizedBlock.number).toBe(9_007_199_254_740_993n);
    expect(latest.transaction).toBe(TRANSACTION);
  });

  it("returns a frozen empty history on first run", async () => {
    const entries = await new JsonlLedgerStore(path).readAll();
    expect(entries).toEqual([]);
    expect(Object.isFrozen(entries)).toBe(true);
  });

  it("stores canonical bigint strings, a schema version, and a resource hash only", async () => {
    await persist(authorizedLifecycle());
    const raw = await readFile(path, "utf8");
    const first = (await wireLines())[0]!;
    const evidenceQuote = first.quote as Record<string, unknown>;

    expect(first.schemaVersion).toBe(1);
    expect(first.amount).toBe("1800000");
    expect(evidenceQuote.amount).toBe("1800000");
    expect(evidenceQuote.resourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect("resource" in evidenceQuote).toBe(false);
    expect(raw).not.toContain("service.example");
    expect(raw).not.toContain('"note"');
    expect(raw).not.toContain('"amount":1800000');
  });

  it("returns detached, deeply frozen decoded events", async () => {
    await persist(authorizedLifecycle());
    const firstRead = await new JsonlLedgerStore(path).readAll();
    const secondRead = await new JsonlLedgerStore(path).readAll();
    const settled = firstRead.at(-1)!;

    expect(Object.isFrozen(firstRead)).toBe(true);
    expect(Object.isFrozen(settled)).toBe(true);
    expect(Object.isFrozen(settled.quote)).toBe(true);
    expect(settled).not.toBe(secondRead.at(-1));
    if (settled.status !== "settled") throw new Error("expected settled fixture");
    expect(Object.isFrozen(settled.finalizedBlock)).toBe(true);
    expect(() => {
      (settled.quote as { payTo: string }).payTo = PAYER;
    }).toThrow();
  });

  it("rejects extra in-memory fields before creating a ledger", async () => {
    const malicious = { ...held().entry, note: "raw-untrusted-text" } as unknown as Entry;
    await expect(new JsonlLedgerStore(path).append(malicious)).rejects.toThrow(
      /unknown or missing fields/,
    );
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("strict wire decoding", () => {
  it.each([
    ["JSON number", 1_800_000],
    ["leading zero", "01800000"],
    ["negative", "-1"],
    ["exponent", "18e5"],
    ["whitespace", " 1800000"],
    ["null", null],
    ["uint256 overflow", (1n << 256n).toString()],
  ])("rejects a non-canonical amount: %s", async (_case, invalid) => {
    const line = await oneHeldWire();
    line.amount = invalid;
    await rewriteWire([line]);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/uint256/);
  });

  it("rejects non-canonical validBefore and finalized block integers", async () => {
    await persist(authorizedLifecycle());
    const lines = await wireLines();
    lines[1]!.validBefore = "01";
    await rewriteWire(lines);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/validBefore/);

    await persist([]);
    const repaired = authorizedLifecycle();
    await writeFile(path, "", "utf8");
    await persist(repaired);
    const blockLines = await wireLines();
    (blockLines[4]!.finalizedBlock as Record<string, unknown>).number = 5;
    await rewriteWire(blockLines);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/finalizedBlock.number/);
  });

  it.each([
    ["null", null],
    ["string", String(NOW)],
    ["negative", -1],
    ["fraction", NOW + 0.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects an invalid event time: %s", async (_case, invalid) => {
    const line = await oneHeldWire();
    line.eventAt = invalid;
    await rewriteWire([line]);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/eventAt/);
  });

  it("rejects amount mismatch within an event", async () => {
    const line = await oneHeldWire();
    line.amount = "1800001";
    await rewriteWire([line]);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/differs/);
  });

  it("rejects legacy schema and status/reason mismatches", async () => {
    const line = await oneHeldWire();
    delete line.schemaVersion;
    await rewriteWire([line]);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/unknown or missing/);

    line.schemaVersion = 1;
    line.reason = "settlement_verified";
    await rewriteWire([line]);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/not valid for held/);
  });

  it("rejects partial authorization fields and auth fields forbidden by status", async () => {
    const line = await oneHeldWire();
    line.nonce = NONCE;
    await rewriteWire([line]);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/present together/);

    line.payer = PAYER;
    line.validBefore = VALID_BEFORE.toString();
    await rewriteWire([line]);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/unknown or missing/);
  });

  it("accepts either unsigned or fully authorized indeterminate events", async () => {
    const unsigned = held();
    const uncertainUnsigned = unsigned.ledger.proposeIndeterminate(
      unsigned.entry.holdId,
      "creation_outcome_unknown",
      NOW + 1,
    );
    unsigned.ledger.applyPersisted(uncertainUnsigned);
    await persist(unsigned.ledger.history());
    expect((await new JsonlLedgerStore(path).readAll()).at(-1)!.status).toBe("indeterminate");

    await writeFile(path, "", "utf8");
    const signed = held();
    const attached = signed.ledger.proposeAttachAuthorization(
      signed.entry.holdId,
      NONCE,
      PAYER,
      VALID_BEFORE,
      NOW + 1,
    );
    signed.ledger.applyPersisted(attached);
    const uncertainSigned = signed.ledger.proposeIndeterminate(
      signed.entry.holdId,
      "rpc_unavailable",
      NOW + 2,
    );
    signed.ledger.applyPersisted(uncertainSigned);
    await persist(signed.ledger.history());
    const restored = (await new JsonlLedgerStore(path).readAll()).at(-1)!;
    expect(restored.status).toBe("indeterminate");
    expect("nonce" in restored).toBe(true);
  });

  it("rejects proof-free release and round-trips proof-bearing release", async () => {
    const proofFree = await oneHeldWire();
    proofFree.status = "released";
    proofFree.reason = "caller_attests_unsigned";
    await rewriteWire([proofFree]);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/unknown ledger reason/);

    await writeFile(path, "", "utf8");
    const signed = held();
    const attached = signed.ledger.proposeAttachAuthorization(
      signed.entry.holdId,
      NONCE,
      PAYER,
      VALID_BEFORE,
      NOW + 1,
    );
    signed.ledger.applyPersisted(attached);
    const reconciling = signed.ledger.proposeReconciling(signed.entry.holdId, NOW + 2);
    signed.ledger.applyPersisted(reconciling);
    const released = signed.ledger.proposeReleasedUnused(
      signed.entry.holdId,
      {
        state: "unused_expired",
        finalizedBlock: {
          chainId: SETTLEMENT_PROFILE.chainId,
          number: 11n,
          hash: BLOCK_HASH,
          timestamp: VALID_BEFORE + 1n,
        },
      },
      NOW + 3,
    );
    signed.ledger.applyPersisted(released);
    await persist(signed.ledger.history());
    const signedBack = (await new JsonlLedgerStore(path).readAll()).at(-1)!;
    expect(signedBack).toMatchObject({
      status: "released",
      reason: "authorization_unused_expired",
      validBefore: VALID_BEFORE,
    });
  });

  it("rejects hold IDs whose numeric suffix is not safely representable", async () => {
    const line = await oneHeldWire();
    line.holdId = "hold-9007199254740992";
    await rewriteWire([line]);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/positive safe integer/);
  });

  it("rejects unknown fields at the event, quote, and proof levels", async () => {
    await persist(authorizedLifecycle());
    const lines = await wireLines();
    lines[0]!.note = "forbidden";
    await rewriteWire(lines);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/unknown or missing/);

    delete lines[0]!.note;
    (lines[0]!.quote as Record<string, unknown>).resource = "forbidden";
    await rewriteWire(lines);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/quote has unknown/);

    delete (lines[0]!.quote as Record<string, unknown>).resource;
    (lines[4]!.finalizedBlock as Record<string, unknown>).note = "forbidden";
    await rewriteWire(lines);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(
      /finalizedBlock has unknown/,
    );
  });

  it("rejects duplicate keys, including escaped-equivalent names", async () => {
    await persist([held().entry]);
    const valid = (await readFile(path, "utf8")).trimEnd();
    const duplicate = valid.replace(
      '"holdId":"hold-1"',
      '"holdId":"hold-1","hold\\u0049d":"hold-1"',
    );
    await writeFile(path, `${duplicate}\n`, "utf8");
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/duplicate JSON/);
  });

  it("rejects prototype-risk and other unknown object keys", async () => {
    await persist([held().entry]);
    const valid = (await readFile(path, "utf8")).trimEnd();
    const polluted = valid.replace(/}$/, ',"__proto__":{"polluted":true}}');
    await writeFile(path, `${polluted}\n`, "utf8");
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/unknown or missing/);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects invalid UTF-8, interior blank lines, partial tails, and oversized records", async () => {
    await writeFile(path, Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/valid UTF-8/);

    await writeFile(path, "", "utf8");
    const heldLine = JSON.stringify(await oneHeldWire());
    await writeFile(path, `${heldLine}\n\n${heldLine}\n`, "utf8");
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/record boundary/);

    await writeFile(path, heldLine, "utf8");
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/incomplete record/);

    await writeFile(path, `${" ".repeat(16_385)}\n`, "utf8");
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/record boundary/);
  });

  it("does not echo malformed ledger bytes in parse errors", async () => {
    const privateMarker = "raw-private-marker";
    await writeFile(path, `{"field":"${privateMarker}" invalid}\n`, "utf8");
    try {
      await new JsonlLedgerStore(path).readAll();
      throw new Error("malformed fixture unexpectedly loaded");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(privateMarker);
      expect((error as Error).message).toContain("invalid JSON encoding");
    }
  });

  it("rejects a ledger larger than the bounded 64 MiB read envelope", async () => {
    await writeFile(path, "", { mode: 0o600 });
    await truncate(path, 64 * 1024 * 1024 + 1);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/bounded file size/);
    await expect(new JsonlLedgerStore(path).append(held().entry)).rejects.toThrow(
      /bounded file size/,
    );
  });
});

describe("full lifecycle replay", () => {
  it("rejects an event stream whose first event is not held", async () => {
    await persist(authorizedLifecycle().slice(1, 2));
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/lifecycle replay/);
  });

  it("rejects fact drift across otherwise valid events", async () => {
    await persist(authorizedLifecycle().slice(0, 2));
    const lines = await wireLines();
    lines[1]!.amount = "1800001";
    (lines[1]!.quote as Record<string, unknown>).amount = "1800001";
    await rewriteWire(lines);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/lifecycle replay/);
  });

  it("rejects authority entering without an authorization_attached event", async () => {
    await persist(authorizedLifecycle());
    const lines = await wireLines();
    await rewriteWire([lines[0]!, lines[2]!]);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/lifecycle replay/);
  });

  it("rejects a terminal hold followed by another event", async () => {
    const lifecycle = authorizedLifecycle();
    await persist([...lifecycle, lifecycle[2]!]);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/lifecycle replay/);
  });

  it("rejects an expired-authorization release without a strictly later finalized block", async () => {
    const { ledger, entry } = held();
    const attached = ledger.proposeAttachAuthorization(
      entry.holdId,
      NONCE,
      PAYER,
      VALID_BEFORE,
      NOW + 1,
    );
    ledger.applyPersisted(attached);
    const released = {
      ...attached,
      status: "released",
      reason: "authorization_unused_expired",
      eventAt: NOW + 2,
      finalizedBlock: {
        chainId: SETTLEMENT_PROFILE.chainId,
        number: 1n,
        hash: BLOCK_HASH,
        timestamp: VALID_BEFORE,
      },
    } as const;
    await expect(new JsonlLedgerStore(path).append(released)).rejects.toThrow(/strictly past/);
  });
});

describe("safe POSIX target handling", () => {
  it("creates the ledger as 0600 and repairs an existing private-mode drift", async () => {
    await persist([held().entry]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await chmod(path, 0o644);
    await new JsonlLedgerStore(path).readAll();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects a symlink target without modifying its destination", async () => {
    const destination = join(dir, "destination.jsonl");
    await writeFile(destination, "unchanged", "utf8");
    await symlink(destination, path);

    await expect(new JsonlLedgerStore(path).append(held().entry)).rejects.toThrow(/regular file/);
    expect(await readFile(destination, "utf8")).toBe("unchanged");
  });

  it("leaves a proposed event inert when its durable append fails", async () => {
    const ledger = new Ledger();
    const proposal = ledger.proposeHold(quote(), POLICY_HASH, NOW);
    await mkdir(path);

    await expect(new JsonlLedgerStore(path).append(proposal)).rejects.toThrow(/regular file/);
    expect(ledger.history()).toEqual([]);
    expect(ledger.state(proposal.holdId)).toBeUndefined();
  });

  it("rejects hard links", async () => {
    const destination = join(dir, "destination.jsonl");
    await writeFile(destination, "", { mode: 0o600 });
    await link(destination, path);

    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/exactly one link/);
    await expect(new JsonlLedgerStore(path).append(held().entry)).rejects.toThrow(
      /exactly one link/,
    );
  });

  it("rejects FIFO and directory targets before opening them", async () => {
    await run("mkfifo", [path]);
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/regular file/);
    await rm(path);
    await mkdir(path);
    await expect(new JsonlLedgerStore(path).append(held().entry)).rejects.toThrow(/regular file/);
  });
});

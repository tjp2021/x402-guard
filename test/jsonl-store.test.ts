import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlLedgerStore } from "../src/adapters/jsonl-store.js";
import { Ledger } from "../src/ledger.js";
import type { Quote } from "../src/policy.js";
import { parseDecimal } from "../src/amount.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NET = "eip155:84532";
const SELLER = "0xE5f6000000000000000000000000000000007788";
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const usd = (s: string) => parseDecimal(s, 6);

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "x402-guard-"));
  path = join(dir, "ledger.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const quote = (amount = "1.80"): Quote => ({
  amount: usd(amount),
  asset: USDC,
  network: NET,
  payTo: SELLER,
  resource: "https://api.example/report",
});

describe("the ledger survives a crash", () => {
  it("round-trips a hold's whole life through the file", async () => {
    const store = new JsonlLedgerStore(path);

    const l = new Ledger();
    l.hold(quote(), NOW);
    l.attachAuthorization("hold-1", "0xnonce", "0xPAYER", NOW + 60 * 60 * 1000);
    l.confirm("hold-1", "0xtx");
    for (const e of l.history()) await store.append(e);

    const restored = Ledger.restore(await store.readAll());

    expect(restored.history()).toHaveLength(3);
    const latest = restored.history().at(-1)!;
    expect(latest.status).toBe("settled");
    expect(latest.transaction).toBe("0xtx");
    expect(latest.nonce).toBe("0xnonce");
    expect(latest.amount).toBe(usd("1.80"));
    expect(typeof latest.amount).toBe("bigint");
  });

  it("returns an empty ledger on a first run rather than failing", async () => {
    expect(await new JsonlLedgerStore(path).readAll()).toEqual([]);
  });
});

describe("money never becomes a float on the way to disk", () => {
  it("writes amounts as strings, not JSON numbers", async () => {
    const store = new JsonlLedgerStore(path);
    const l = new Ledger();
    l.hold(quote("1.80"), NOW);
    await store.append(l.history()[0]!);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain('"amount":"1800000"'); // string
    expect(raw).not.toContain('"amount":1800000'); // never a number
  });

  it("round-trips an amount that a JSON number would silently corrupt", async () => {
    // 9007199254740993 is 2^53 + 1. Parsed as a JSON number it becomes
    // ...992 — off by one, silently. As a string it survives exactly.
    const store = new JsonlLedgerStore(path);
    const huge: Quote = { ...quote(), amount: 9_007_199_254_740_993n };

    const l = new Ledger();
    l.hold(huge, NOW);
    await store.append(l.history()[0]!);

    const back = await store.readAll();
    expect(back[0]!.amount).toBe(9_007_199_254_740_993n);
    // Proof the danger is real, not theoretical:
    expect(JSON.parse('{"n":9007199254740993}').n).toBe(9_007_199_254_740_992);
  });
});

describe("the file is a human-readable audit trail", () => {
  it("is one line per entry, greppable, with the deciding facts on it", async () => {
    const store = new JsonlLedgerStore(path);
    const l = new Ledger();
    l.hold(quote(), NOW);
    l.confirm("hold-1", "0xtx");
    for (const e of l.history()) await store.append(e);

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    expect(first.status).toBe("held");
    expect(first.quote.payTo).toBe(SELLER);
    expect(first.quote.resource).toBe("https://api.example/report");

    // The append-only rule, visible on disk: settling ADDS a line. The 'held'
    // line is not edited away — history is the evidence.
    expect(JSON.parse(lines[1]!).status).toBe("settled");
    expect(JSON.parse(lines[0]!).status).toBe("held");
  });

  it("omits unknown fields rather than writing nulls", async () => {
    const store = new JsonlLedgerStore(path);
    const l = new Ledger();
    l.hold(quote(), NOW); // no transaction, no nonce yet
    await store.append(l.history()[0]!);

    const line = JSON.parse((await readFile(path, "utf8")).trim());
    expect("transaction" in line).toBe(false);
    expect("nonce" in line).toBe(false);
  });
});

describe("a nonce without validBefore is refused — it would double-spend", () => {
  it("throws on a line carrying a nonce but no validBefore", async () => {
    // A nonce means a payload was signed; without validBefore the reconciler
    // cannot know when the bearer authorization stops being submittable and
    // would release it early. This is the migration path: a ledger written
    // before validBefore existed. It must not load.
    const line = JSON.stringify({
      holdId: "hold-1", status: "held", amount: "1800000", at: NOW,
      quote: { amount: "1800000", asset: USDC, network: NET, payTo: SELLER, resource: "r" },
      nonce: "0xabc", payer: "0xPAYER", // no validBefore
    });
    await writeFile(path, line + "\n", "utf8");
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/validBefore/);
  });
});

describe("a corrupt ledger is refused, not silently skipped", () => {
  it("throws rather than under-counting committed spend", async () => {
    // Skipping a bad line would under-count spend, and under-counting spend is
    // exactly how a budget gets exceeded. Failing to start is the safe move.
    await writeFile(path, '{"holdId":"hold-1","status":"held"\nnot json at all\n', "utf8");
    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(/corrupt/);
  });

  it("names the line number, so the operator can go look at it", async () => {
    const store = new JsonlLedgerStore(path);
    const l = new Ledger();
    l.hold(quote(), NOW);
    await store.append(l.history()[0]!);
    await writeFile(path, (await readFile(path, "utf8")) + "{{{garbage\n", "utf8");

    await expect(store.readAll()).rejects.toThrow(/:2 is corrupt/);
  });
});

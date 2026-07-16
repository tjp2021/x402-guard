import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const swap = vi.hoisted(() => ({
  armed: false,
  target: "",
  replacement: "",
  backup: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const result = await actual.lstat(...args);
      if (swap.armed && String(args[0]) === swap.target) {
        swap.armed = false;
        await actual.rename(swap.target, swap.backup);
        await actual.rename(swap.replacement, swap.target);
      }
      return result;
    },
  };
});

import { JsonlLedgerStore } from "../src/adapters/jsonl-store.js";
import { Ledger } from "../src/ledger.js";
import { SETTLEMENT_PROFILE, type Quote } from "../src/policy.js";

const POLICY_HASH = `sha256:${"ab".repeat(32)}`;
const PAYEE = "0xE5f6000000000000000000000000000000007788";
const NOW = Date.UTC(2026, 6, 16, 12, 0, 0);

let dir: string;
let path: string;
let replacement: string;
let backup: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "x402-guard-inode-"));
  path = join(dir, "ledger.jsonl");
  replacement = join(dir, "replacement.jsonl");
  backup = join(dir, "original.jsonl");
  Object.assign(swap, { armed: false, target: path, replacement, backup });
});

afterEach(async () => {
  swap.armed = false;
  await rm(dir, { recursive: true, force: true });
});

function proposedHold() {
  const quote: Quote = {
    amount: 1n,
    asset: SETTLEMENT_PROFILE.asset,
    network: SETTLEMENT_PROFILE.network,
    payTo: PAYEE,
    resource: "resource",
  };
  return new Ledger().proposeHold(quote, POLICY_HASH, NOW);
}

describe("ledger leaf identity", () => {
  it("rejects a read when the path is swapped after lstat but before open", async () => {
    await writeFile(path, "", { mode: 0o600 });
    await writeFile(replacement, "", { mode: 0o600 });
    swap.armed = true;

    await expect(new JsonlLedgerStore(path).readAll()).rejects.toThrow(
      /identity changed during open/,
    );
  });

  it("rejects an append before writing when the path resolves to a new inode", async () => {
    await writeFile(path, "original", { mode: 0o600 });
    await writeFile(replacement, "replacement", { mode: 0o600 });
    swap.armed = true;

    await expect(new JsonlLedgerStore(path).append(proposedHold())).rejects.toThrow(
      /identity changed during open/,
    );
    expect(await readFile(path, "utf8")).toBe("replacement");
    expect(await readFile(backup, "utf8")).toBe("original");
  });
});

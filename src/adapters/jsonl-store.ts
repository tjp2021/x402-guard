/**
 * The durable ledger: an append-only JSONL file.
 *
 * One JSON object per line. Appended, never rewritten. A settle does not edit
 * the line that recorded the hold — it adds a new line. Both survive, so the
 * whole life of a payment reads top to bottom.
 *
 * This file IS the audit trail the project is selling, which drives three rules:
 *
 * 1. It is plain text. An audit trail you need special software to read is not
 *    an audit trail. `tail -f`, `grep`, and human eyes all work.
 *
 * 2. It is written by us, to our disk, BEFORE the money moves. x402 issue #2821
 *    is "14 settled payments the facilitator's index lost." A ledger that
 *    depends on the facilitator loses them too.
 *
 * 3. Amounts are atomic-unit STRINGS, never JSON numbers. JSON numbers are IEEE
 *    doubles; round-tripping 9007199254740993 through one silently changes it.
 *    Serializing a bigint as a number would quietly undo the entire reason the
 *    arithmetic is integer-only.
 *
 * No secrets. Public addresses and public transaction hashes only.
 */

import { open, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Entry } from "../ledger.js";
import type { LedgerStore } from "../ports.js";
import type { Quote } from "../policy.js";

/** The on-disk shape. Every amount is a string; nothing here is a JS number. */
interface Line {
  holdId: string;
  status: Entry["status"];
  amount: string;
  at: number;
  quote: {
    amount: string;
    asset: string;
    network: string;
    payTo: string;
    resource: string;
  };
  transaction?: string;
  nonce?: string;
  payer?: string;
  validBefore?: number;
  note?: string;
}

export class JsonlLedgerStore implements LedgerStore {
  constructor(private readonly path: string) {}

  async append(entry: Entry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // fsync, not just appendFile. "Written to disk before the money moves" is a
    // durability claim, and appendFile only reaches the OS page cache — it
    // survives a process crash but NOT power loss or a hard kill, which is the
    // exact class of failure (facilitator lost the record) this ledger exists to
    // outlast. Open, write one line, flush, close.
    const fh = await open(this.path, "a");
    try {
      await fh.write(JSON.stringify(encode(entry)) + "\n");
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  async readAll(): Promise<Entry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      // No ledger yet is a legitimate state: a first run. Any other error is
      // not, and must not be swallowed — a ledger we cannot read is a budget we
      // cannot enforce, and the caller has to fail closed rather than start
      // from zero.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }

    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((line, i) => {
        try {
          return decode(JSON.parse(line) as Line);
        } catch (e) {
          // A corrupt line means the ledger is not trustworthy. Refusing to
          // start is correct: silently skipping it would under-count committed
          // spend, and under-counting spend is how a budget gets exceeded.
          throw new Error(
            `ledger ${this.path}:${i + 1} is corrupt: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      });
  }
}

function encode(e: Entry): Line {
  const q: Line["quote"] = {
    amount: e.quote.amount.toString(),
    asset: e.quote.asset,
    network: e.quote.network,
    payTo: e.quote.payTo,
    resource: e.quote.resource,
  };
  const line: Line = {
    holdId: e.holdId,
    status: e.status,
    amount: e.amount.toString(),
    at: e.at,
    quote: q,
  };
  // Omit rather than write null, so a line says only what is known.
  if (e.transaction !== undefined) line.transaction = e.transaction;
  if (e.nonce !== undefined) line.nonce = e.nonce;
  if (e.payer !== undefined) line.payer = e.payer;
  if (e.validBefore !== undefined) line.validBefore = e.validBefore;
  if (e.note !== undefined) line.note = e.note;
  return line;
}

const STATUSES: ReadonlySet<string> = new Set([
  "held", "settled", "released", "reconciling", "indeterminate",
]);

function decode(l: Line): Entry {
  // Validate the fields that decide budget math. Catching only JSON syntax
  // errors is not enough: a hand-edited negative amount or an unknown status
  // loads cleanly and corrupts committed spend — a negative amount MINTS
  // budget. The strict parser exists; use it at the boundary where data
  // re-enters the process.
  if (!STATUSES.has(l.status)) {
    throw new Error(`unknown status ${JSON.stringify(l.status)}`);
  }
  // Rule 3 of this file: amounts are strings, never JSON numbers. Enforce it,
  // don't just document it — BigInt(5) succeeds, so a numeric amount would load
  // silently. Worse, a number past 2^53 is already mangled by JSON.parse before
  // we ever see it, so the only defense is to reject the type at the boundary.
  if (typeof l.amount !== "string" || typeof l.quote.amount !== "string") {
    throw new Error(
      `amounts must be strings, not JSON numbers (entry ${l.holdId})`,
    );
  }
  const amount = BigInt(l.amount);
  if (amount < 0n) throw new Error(`negative amount ${l.amount}`);
  if (BigInt(l.quote.amount) < 0n) throw new Error(`negative quote amount ${l.quote.amount}`);
  // A nonce means a payload was signed; without validBefore the reconciler
  // cannot know when the bearer authorization stops being submittable, and
  // would release it early — the double-spend. Enforce the pairing at the disk
  // boundary, not only in the attachAuthorization signature, because restore()
  // is the real ingest path (e.g. a ledger written before validBefore existed).
  if (l.nonce !== undefined && l.validBefore === undefined) {
    throw new Error(`entry ${l.holdId} carries a nonce but no validBefore`);
  }
  const quote: Quote = {
    amount: BigInt(l.quote.amount),
    asset: l.quote.asset,
    network: l.quote.network,
    payTo: l.quote.payTo,
    resource: l.quote.resource,
  };
  const entry: Entry = {
    holdId: l.holdId,
    status: l.status,
    amount,
    at: l.at,
    quote,
  };
  if (l.transaction !== undefined) entry.transaction = l.transaction;
  if (l.nonce !== undefined) entry.nonce = l.nonce;
  if (l.payer !== undefined) entry.payer = l.payer;
  if (l.validBefore !== undefined) entry.validBefore = l.validBefore;
  if (l.note !== undefined) entry.note = l.note;
  return entry;
}

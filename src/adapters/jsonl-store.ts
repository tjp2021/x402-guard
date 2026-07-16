/**
 * Durable, append-only payment evidence.
 *
 * The wire format is deliberately smaller than the in-memory request model:
 * it stores only bounded reason codes and a SHA-256 resource fingerprint. Raw
 * URLs, operator notes, and upstream error text are not ledger fields.
 *
 * POSIX contract: one writer owns a trusted, stable parent directory. The leaf
 * ledger target may be hostile and is checked without following symlinks;
 * ancestor-symlink defense and multiwriter locking are deliberately not part
 * of this v0.1 adapter.
 */

import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";
import { TextDecoder } from "node:util";
import {
  LEDGER_SCHEMA_VERSION,
  Ledger,
  type Entry,
  type IndeterminateReason,
  type LedgerReason,
} from "../ledger.js";
import {
  CHAIN_UNKNOWN_REASONS,
  type FinalizedBlockProof,
  type LedgerStore,
} from "../ports.js";
import { SETTLEMENT_PROFILE, type EvidenceQuote } from "../policy.js";

type JsonObject = Record<string, unknown>;

const COMMON_KEYS = [
  "schemaVersion",
  "holdId",
  "status",
  "reason",
  "heldAt",
  "eventAt",
  "policyHash",
  "amount",
  "quote",
] as const;
const AUTH_KEYS = ["nonce", "payer", "validBefore"] as const;
const QUOTE_KEYS = ["amount", "asset", "network", "payTo", "resourceHash"] as const;
const BLOCK_KEYS = ["chainId", "number", "hash", "timestamp"] as const;

const HOLD_ID = /^hold-[1-9][0-9]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES_32 = /^0x[0-9a-fA-F]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_LINE_BYTES = 16_384;
// Explicit startup/OOM envelope. Larger audit histories need deliberate
// archival rather than an unbounded read into the payment process.
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

const INDETERMINATE_REASONS: ReadonlySet<string> = new Set([
  "creation_outcome_unknown",
  "authorization_unreadable",
  ...CHAIN_UNKNOWN_REASONS,
]);

const LEDGER_REASONS: ReadonlySet<string> = new Set([
  "authorized",
  "authorization_attached",
  ...INDETERMINATE_REASONS,
  "settlement_reported",
  "chain_lookup_started",
  "settlement_verified",
  "authorization_unused_expired",
]);

type EntryShape = {
  status: Entry["status"];
  reason: LedgerReason;
  hasAuthorization: boolean;
  keys: readonly string[];
};

export class JsonlLedgerStore implements LedgerStore {
  constructor(private readonly path: string) {}

  async append(entry: Entry): Promise<void> {
    const wire = encodeEntry(entry);
    const payload = Buffer.from(`${JSON.stringify(wire)}\n`, "utf8");
    if (payload.byteLength > MAX_LINE_BYTES) {
      throw new Error("ledger entry exceeds the bounded wire size");
    }

    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const target = await openAppendTarget(this.path);
    let succeeded = false;
    try {
      await enforcePrivateMode(target.handle);
      await assertPathIdentity(this.path, target.identity);
      const beforeWrite = await checkedHandleStats(target.handle);
      if (beforeWrite.size + BigInt(payload.byteLength) > BigInt(MAX_LEDGER_BYTES)) {
        throw new Error("ledger exceeds the bounded file size");
      }
      const { bytesWritten } = await target.handle.write(
        payload,
        0,
        payload.byteLength,
        null,
      );
      if (bytesWritten !== payload.byteLength) {
        throw new Error("ledger append was incomplete");
      }
      await target.handle.sync();
      await assertPathIdentity(this.path, target.identity);
      succeeded = true;
    } finally {
      await target.handle.close();
    }

    // The file fsync makes contents durable; a directory fsync makes the new
    // name durable. Existing names do not need a directory entry flush.
    if (succeeded && target.created) await syncDirectory(parent);
  }

  async readAll(): Promise<Entry[]> {
    const opened = await openReadTarget(this.path);
    if (!opened) return Object.freeze([]) as unknown as Entry[];

    let bytes: Buffer;
    try {
      await enforcePrivateMode(opened.handle);
      await assertPathIdentity(this.path, opened.identity);
      bytes = await readBounded(opened.handle);
      await assertPathIdentity(this.path, opened.identity);
    } finally {
      await opened.handle.close();
    }

    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`ledger ${this.path} is not valid UTF-8`, { cause: error });
    }

    if (raw.length === 0) return Object.freeze([]) as unknown as Entry[];
    if (!raw.endsWith("\n")) {
      throw new Error(`ledger ${this.path} ends with an incomplete record`);
    }

    const lines = raw.slice(0, -1).split("\n");
    const entries: Entry[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        throw corruptLine(this.path, index + 1, "invalid record boundary");
      }
      let parsed: unknown;
      try {
        assertNoDuplicateJsonKeys(line);
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        // V8 may include source snippets in SyntaxError messages. Keep raw
        // ledger bytes out of operator-visible errors and logs.
        const detail =
          error instanceof Error && error.message === "duplicate JSON object key"
            ? error.message
            : "invalid JSON encoding";
        throw corruptLine(this.path, index + 1, detail);
      }
      try {
        entries.push(decodeEntry(parsed));
      } catch (error) {
        throw corruptLine(
          this.path,
          index + 1,
          error instanceof Error ? error.message : "invalid record",
          error,
        );
      }
    }

    try {
      const restored = Ledger.restore(entries);
      return Object.freeze([...restored.history()]) as unknown as Entry[];
    } catch (error) {
      throw new Error(`ledger ${this.path} failed lifecycle replay validation`, {
        cause: error,
      });
    }
  }
}

function encodeEntry(entry: Entry): JsonObject {
  const record = asObject(entry, "entry");
  const shape = inspectEntryShape(record);
  exactKeys(record, shape.keys, "entry");

  const common = {
    schemaVersion: schemaVersion(record.schemaVersion),
    holdId: boundedHoldId(record.holdId),
    status: shape.status,
    reason: shape.reason,
    heldAt: safeTime(record.heldAt, "heldAt"),
    eventAt: safeTime(record.eventAt, "eventAt"),
    policyHash: matchingString(record.policyHash, SHA256, "policyHash"),
    amount: runtimeUint(record.amount, "amount").toString(),
    quote: encodeQuote(record.quote),
  };
  validateCommon(common, record.amount, record.quote);

  switch (shape.status) {
    case "held":
      return common;
    case "authorization_attached":
    case "reconciling":
      return { ...common, ...encodeAuthorization(record) };
    case "indeterminate":
      return shape.hasAuthorization
        ? { ...common, ...encodeAuthorization(record) }
        : common;
    case "settlement_reported":
      return {
        ...common,
        ...encodeAuthorization(record),
        transactionHint: matchingString(record.transactionHint, BYTES_32, "transactionHint"),
      };
    case "settled": {
      const settlementAt = safeTime(record.settlementAt, "settlementAt");
      const finalizedBlock = encodeFinalizedBlock(record.finalizedBlock);
      validateSettledTiming(settlementAt, finalizedBlock);
      return {
        ...common,
        ...encodeAuthorization(record),
        transaction: matchingString(record.transaction, BYTES_32, "transaction"),
        settlementAt,
        finalizedBlock,
      };
    }
    case "released":
      {
        const authorization = encodeAuthorization(record);
        const finalizedBlock = encodeFinalizedBlock(record.finalizedBlock);
        validateUnusedDeadline(authorization.validBefore, finalizedBlock);
        return { ...common, ...authorization, finalizedBlock };
      }
  }
}

function decodeEntry(value: unknown): Entry {
  const record = asObject(value, "entry");
  const shape = inspectEntryShape(record);
  exactKeys(record, shape.keys, "entry");

  const quote = decodeQuote(record.quote);
  const amount = wireUint(record.amount, "amount");
  const base = {
    schemaVersion: schemaVersion(record.schemaVersion),
    holdId: boundedHoldId(record.holdId),
    heldAt: safeTime(record.heldAt, "heldAt"),
    eventAt: safeTime(record.eventAt, "eventAt"),
    policyHash: matchingString(record.policyHash, SHA256, "policyHash"),
    amount,
    quote,
  };
  validateCommon(base, amount, quote);

  let entry: Entry;
  switch (shape.status) {
    case "held":
      entry = { ...base, status: "held", reason: "authorized" };
      break;
    case "authorization_attached":
      entry = {
        ...base,
        status: "authorization_attached",
        reason: "authorization_attached",
        ...decodeAuthorization(record),
      };
      break;
    case "indeterminate":
      entry = {
        ...base,
        status: "indeterminate",
        reason: shape.reason as IndeterminateReason,
        ...(shape.hasAuthorization ? decodeAuthorization(record) : {}),
      };
      break;
    case "settlement_reported":
      entry = {
        ...base,
        status: "settlement_reported",
        reason: "settlement_reported",
        ...decodeAuthorization(record),
        transactionHint: matchingString(record.transactionHint, BYTES_32, "transactionHint"),
      };
      break;
    case "reconciling":
      entry = {
        ...base,
        status: "reconciling",
        reason: "chain_lookup_started",
        ...decodeAuthorization(record),
      };
      break;
    case "settled": {
      const settlementAt = safeTime(record.settlementAt, "settlementAt");
      const finalizedBlock = decodeFinalizedBlock(record.finalizedBlock);
      validateSettledTiming(settlementAt, finalizedBlock);
      entry = {
        ...base,
        status: "settled",
        reason: "settlement_verified",
        ...decodeAuthorization(record),
        transaction: matchingString(record.transaction, BYTES_32, "transaction"),
        settlementAt,
        finalizedBlock,
      };
      break;
    }
    case "released":
      {
        const authorization = decodeAuthorization(record);
        const finalizedBlock = decodeFinalizedBlock(record.finalizedBlock);
        validateUnusedDeadline(authorization.validBefore, finalizedBlock);
        entry = {
          ...base,
          status: "released",
          reason: "authorization_unused_expired",
          ...authorization,
          finalizedBlock,
        };
      }
      break;
  }
  return freezeEntry(entry);
}

function inspectEntryShape(record: JsonObject): EntryShape {
  const status = knownStatus(record.status);
  const reason = knownReason(record.reason);
  const authCount = AUTH_KEYS.filter((key) => hasOwn(record, key)).length;
  if (authCount !== 0 && authCount !== AUTH_KEYS.length) {
    throw new Error("authorization fields must be present together");
  }
  const hasAuthorization = authCount === AUTH_KEYS.length;

  switch (status) {
    case "held":
      exactReason(reason, "authorized", status);
      return shape(status, reason, false, []);
    case "authorization_attached":
      exactReason(reason, "authorization_attached", status);
      return shape(status, reason, true, AUTH_KEYS);
    case "indeterminate":
      if (!INDETERMINATE_REASONS.has(reason)) {
        throw new Error("reason is not valid for indeterminate status");
      }
      return shape(status, reason, hasAuthorization, hasAuthorization ? AUTH_KEYS : []);
    case "settlement_reported":
      exactReason(reason, "settlement_reported", status);
      return shape(status, reason, true, [...AUTH_KEYS, "transactionHint"]);
    case "reconciling":
      exactReason(reason, "chain_lookup_started", status);
      return shape(status, reason, true, AUTH_KEYS);
    case "settled":
      exactReason(reason, "settlement_verified", status);
      return shape(status, reason, true, [
        ...AUTH_KEYS,
        "transaction",
        "settlementAt",
        "finalizedBlock",
      ]);
    case "released":
      if (reason === "authorization_unused_expired") {
        return shape(status, reason, true, [...AUTH_KEYS, "finalizedBlock"]);
      }
      throw new Error("reason is not valid for released status");
  }
}

function shape(
  status: Entry["status"],
  reason: LedgerReason,
  requiresAuthorization: boolean,
  extraKeys: readonly string[],
): EntryShape {
  const authCount = extraKeys.filter((key) => AUTH_KEYS.includes(key as never)).length;
  if (requiresAuthorization && authCount !== AUTH_KEYS.length) {
    throw new Error("authorization fields are required for this status");
  }
  return {
    status,
    reason,
    hasAuthorization: requiresAuthorization,
    keys: [...COMMON_KEYS, ...extraKeys],
  };
}

function exactReason(actual: LedgerReason, expected: LedgerReason, status: string): void {
  if (actual !== expected) throw new Error(`reason is not valid for ${status} status`);
}

function knownStatus(value: unknown): Entry["status"] {
  if (
    value !== "held" &&
    value !== "authorization_attached" &&
    value !== "indeterminate" &&
    value !== "settlement_reported" &&
    value !== "reconciling" &&
    value !== "settled" &&
    value !== "released"
  ) {
    throw new Error("unknown ledger status");
  }
  return value;
}

function knownReason(value: unknown): LedgerReason {
  if (typeof value !== "string" || !LEDGER_REASONS.has(value)) {
    throw new Error("unknown ledger reason");
  }
  return value as LedgerReason;
}

function encodeQuote(value: unknown): JsonObject {
  const quote = asObject(value, "quote");
  exactKeys(quote, QUOTE_KEYS, "quote");
  return {
    amount: runtimeUint(quote.amount, "quote.amount").toString(),
    asset: supportedAsset(quote.asset),
    network: supportedNetwork(quote.network),
    payTo: matchingString(quote.payTo, ADDRESS, "quote.payTo"),
    resourceHash: matchingString(quote.resourceHash, SHA256, "quote.resourceHash"),
  };
}

function decodeQuote(value: unknown): EvidenceQuote {
  const quote = asObject(value, "quote");
  exactKeys(quote, QUOTE_KEYS, "quote");
  return Object.freeze({
    amount: wireUint(quote.amount, "quote.amount"),
    asset: supportedAsset(quote.asset),
    network: supportedNetwork(quote.network),
    payTo: matchingString(quote.payTo, ADDRESS, "quote.payTo"),
    resourceHash: matchingString(quote.resourceHash, SHA256, "quote.resourceHash"),
  });
}

function encodeAuthorization(record: JsonObject): {
  nonce: string;
  payer: string;
  validBefore: string;
} {
  return {
    nonce: matchingString(record.nonce, BYTES_32, "nonce"),
    payer: matchingString(record.payer, ADDRESS, "payer"),
    validBefore: runtimeUint(record.validBefore, "validBefore").toString(),
  };
}

function decodeAuthorization(record: JsonObject): {
  nonce: string;
  payer: string;
  validBefore: bigint;
} {
  return {
    nonce: matchingString(record.nonce, BYTES_32, "nonce"),
    payer: matchingString(record.payer, ADDRESS, "payer"),
    validBefore: wireUint(record.validBefore, "validBefore"),
  };
}

function encodeFinalizedBlock(value: unknown): JsonObject {
  const block = asObject(value, "finalizedBlock");
  exactKeys(block, BLOCK_KEYS, "finalizedBlock");
  if (block.chainId !== SETTLEMENT_PROFILE.chainId) {
    throw new Error("finalizedBlock.chainId is unsupported");
  }
  return {
    chainId: block.chainId,
    number: runtimeUint(block.number, "finalizedBlock.number").toString(),
    hash: matchingString(block.hash, BYTES_32, "finalizedBlock.hash"),
    timestamp: runtimeUint(block.timestamp, "finalizedBlock.timestamp").toString(),
  };
}

function decodeFinalizedBlock(value: unknown): FinalizedBlockProof {
  const block = asObject(value, "finalizedBlock");
  exactKeys(block, BLOCK_KEYS, "finalizedBlock");
  if (block.chainId !== SETTLEMENT_PROFILE.chainId) {
    throw new Error("finalizedBlock.chainId is unsupported");
  }
  return Object.freeze({
    chainId: SETTLEMENT_PROFILE.chainId,
    number: wireUint(block.number, "finalizedBlock.number"),
    hash: matchingString(block.hash, BYTES_32, "finalizedBlock.hash"),
    timestamp: wireUint(block.timestamp, "finalizedBlock.timestamp"),
  });
}

function validateCommon(
  common: { heldAt: number; eventAt: number; amount: unknown; quote: unknown },
  amountValue: unknown,
  quoteValue: unknown,
): void {
  if (common.eventAt < common.heldAt) throw new Error("eventAt precedes heldAt");
  const amount = typeof amountValue === "bigint"
    ? runtimeUint(amountValue, "amount")
    : wireUint(amountValue, "amount");
  const quote = asObject(quoteValue, "quote");
  const quoteAmount = typeof quote.amount === "bigint"
    ? runtimeUint(quote.amount, "quote.amount")
    : wireUint(quote.amount, "quote.amount");
  if (amount !== quoteAmount) throw new Error("amount differs from quote.amount");
}

function validateSettledTiming(settlementAt: number, block: JsonObject | FinalizedBlockProof): void {
  const timestamp = typeof block.timestamp === "bigint"
    ? block.timestamp
    : wireUint(block.timestamp, "finalizedBlock.timestamp");
  if (timestamp * 1000n < BigInt(settlementAt)) {
    throw new Error("settlementAt is after the finalized block observation");
  }
}

function validateUnusedDeadline(
  validBefore: string | bigint,
  block: JsonObject | FinalizedBlockProof,
): void {
  const deadline = typeof validBefore === "bigint"
    ? validBefore
    : wireUint(validBefore, "validBefore");
  const timestamp = typeof block.timestamp === "bigint"
    ? block.timestamp
    : wireUint(block.timestamp, "finalizedBlock.timestamp");
  if (timestamp <= deadline) {
    throw new Error("unused proof is not strictly past validBefore");
  }
}

function supportedAsset(value: unknown): string {
  const asset = matchingString(value, ADDRESS, "quote.asset");
  if (asset.toLowerCase() !== SETTLEMENT_PROFILE.asset.toLowerCase()) {
    throw new Error("quote.asset is unsupported");
  }
  return asset;
}

function supportedNetwork(value: unknown): string {
  if (value !== SETTLEMENT_PROFILE.network) throw new Error("quote.network is unsupported");
  return value;
}

function schemaVersion(value: unknown): typeof LEDGER_SCHEMA_VERSION {
  if (value !== LEDGER_SCHEMA_VERSION) throw new Error("unsupported ledger schema version");
  return LEDGER_SCHEMA_VERSION;
}

function boundedHoldId(value: unknown): string {
  const holdId = matchingString(value, HOLD_ID, "holdId");
  const sequence = Number(holdId.slice("hold-".length));
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error("holdId sequence must be a positive safe integer");
  }
  return holdId;
}

function safeTime(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function runtimeUint(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    throw new Error(`${label} must be an unsigned uint256 bigint`);
  }
  return value;
}

function wireUint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !CANONICAL_UINT.test(value) || value.length > 78) {
    throw new Error(`${label} must be a canonical uint256 string`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT256) throw new Error(`${label} exceeds uint256`);
  return parsed;
}

function matchingString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} has an invalid format`);
  }
  return value;
}

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as JsonObject;
}

function exactKeys(record: JsonObject, expected: readonly string[], label: string): void {
  const keys = Reflect.ownKeys(record);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== expected.length ||
    expected.some((key) => !hasOwn(record, key))
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function hasOwn(record: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function freezeEntry<T extends Entry>(entry: T): T {
  Object.freeze(entry.quote);
  if ("finalizedBlock" in entry) Object.freeze(entry.finalizedBlock);
  return Object.freeze(entry);
}

async function openAppendTarget(path: string): Promise<{
  handle: FileHandle;
  identity: BigIntStats;
  created: boolean;
}> {
  const createFlags =
    constants.O_WRONLY |
    constants.O_APPEND |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW;
  try {
    const handle = await open(path, createFlags, 0o600);
    try {
      const identity = await checkedHandleStats(handle);
      await assertPathIdentity(path, identity);
      return { handle, identity, created: true };
    } catch (error) {
      await handle.close();
      throw error;
    }
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }

  const before = await checkedPathStats(path);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
  );
  try {
    const identity = await checkedHandleStats(handle);
    assertSameIdentity(before, identity);
    await assertPathIdentity(path, identity);
    return { handle, identity, created: false };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openReadTarget(path: string): Promise<{
  handle: FileHandle;
  identity: BigIntStats;
} | undefined> {
  let before: BigIntStats;
  try {
    before = await checkedPathStats(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = await checkedHandleStats(handle);
    assertSameIdentity(before, identity);
    await assertPathIdentity(path, identity);
    return { handle, identity };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function checkedPathStats(path: string): Promise<BigIntStats> {
  const stats = await lstat(path, { bigint: true });
  assertSafeLedgerTarget(stats);
  return stats;
}

async function checkedHandleStats(handle: FileHandle): Promise<BigIntStats> {
  const stats = await handle.stat({ bigint: true });
  assertSafeLedgerTarget(stats);
  return stats;
}

function assertSafeLedgerTarget(stats: BigIntStats): void {
  if (!stats.isFile()) throw new Error("ledger target must be a regular file");
  if (stats.nlink !== 1n) throw new Error("ledger target must have exactly one link");
}

function assertSameIdentity(expected: BigIntStats, actual: BigIntStats): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error("ledger target identity changed during open");
  }
}

async function assertPathIdentity(path: string, identity: BigIntStats): Promise<void> {
  const current = await checkedPathStats(path);
  assertSameIdentity(identity, current);
}

async function enforcePrivateMode(handle: FileHandle): Promise<void> {
  await handle.chmod(0o600);
  const stats = await checkedHandleStats(handle);
  if ((stats.mode & 0o777n) !== 0o600n) {
    throw new Error("ledger target permissions are not 0600");
  }
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const initial = await checkedHandleStats(handle);
  if (initial.size > BigInt(MAX_LEDGER_BYTES)) {
    throw new Error("ledger exceeds the bounded file size");
  }

  const chunks: Buffer[] = [];
  let position = 0;
  while (true) {
    const remaining = MAX_LEDGER_BYTES + 1 - position;
    if (remaining <= 0) throw new Error("ledger exceeds the bounded file size");
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    position += bytesRead;
    if (position > MAX_LEDGER_BYTES) {
      throw new Error("ledger exceeds the bounded file size");
    }
  }
  return Buffer.concat(chunks, position);
}

/** Detect duplicate object keys before JSON.parse discards the earlier value. */
function assertNoDuplicateJsonKeys(source: string): void {
  type Frame =
    | { kind: "object"; keys: Set<string>; expectingKey: boolean }
    | { kind: "array" };
  const stack: Frame[] = [];

  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character === '"') {
      const start = index;
      let escaped = false;
      for (index += 1; index < source.length; index++) {
        const current = source[index]!;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (current === "\\") {
          escaped = true;
          continue;
        }
        if (current === '"') break;
      }
      if (index >= source.length) throw new Error("unterminated JSON string");
      const frame = stack.at(-1);
      if (frame?.kind === "object" && frame.expectingKey) {
        const key = JSON.parse(source.slice(start, index + 1)) as unknown;
        if (typeof key !== "string") throw new Error("invalid JSON object key");
        if (frame.keys.has(key)) throw new Error("duplicate JSON object key");
        frame.keys.add(key);
        frame.expectingKey = false;
      }
      continue;
    }
    if (character === "{") {
      stack.push({ kind: "object", keys: new Set(), expectingKey: true });
      continue;
    }
    if (character === "[") {
      stack.push({ kind: "array" });
      continue;
    }
    if (character === "}" || character === "]") {
      stack.pop();
      continue;
    }
    if (character === ",") {
      const frame = stack.at(-1);
      if (frame?.kind === "object") frame.expectingKey = true;
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function corruptLine(
  path: string,
  line: number,
  detail: string,
  cause?: unknown,
): Error {
  return new Error(`ledger ${path}:${line} is corrupt: ${detail}`, { cause });
}

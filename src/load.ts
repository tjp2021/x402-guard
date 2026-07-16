/**
 * Loading a policy document: parse, validate, hash.
 *
 * The hash is not decoration. Every verdict carries it, so a reader holding a
 * verdict and a policy file can prove the one produced the other — and a policy
 * edited after the fact cannot masquerade as the one that was in force.
 *
 * It is computed over a CANONICAL form (sorted keys, no whitespace), not the
 * raw text, so reformatting the file does not change its identity but changing
 * a limit does.
 *
 * Validation fails closed and fails loudly. A policy that cannot be understood
 * is not a policy that permits everything; it is a policy that permits nothing.
 * A typo in a spending limit must never silently become an unlimited budget.
 */

import { createHash } from "node:crypto";
import { parseDecimal, AmountError } from "./amount.js";
import { SETTLEMENT_PROFILE } from "./policy.js";
import type { Policy, Budget, BudgetWindow, Payee } from "./policy.js";

export class PolicyError extends Error {}

const LOADED_POLICY: unique symbol = Symbol("x402-guard.LoadedPolicy");
const loadedPolicies = new WeakSet<object>();

/** A validated immutable policy and the hash derived from that exact value. */
export interface LoadedPolicy {
  readonly policy: Policy;
  readonly hash: string;
  readonly [LOADED_POLICY]: true;
}

export function isLoadedPolicy(value: unknown): value is LoadedPolicy {
  return typeof value === "object" && value !== null && loadedPolicies.has(value);
}

const WINDOWS: readonly BudgetWindow[] = ["rolling-1h", "rolling-24h"];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CAIP2 = /^[a-z0-9-]+:[a-zA-Z0-9-]+$/;
const UINT256_MAX = (1n << 256n) - 1n;

/** The raw document shape, before validation. Everything is unknown until checked. */
type Raw = Record<string, unknown>;

function obj(v: unknown, path: string): Raw {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new PolicyError(`${path}: expected an object`);
  }
  return v as Raw;
}

/**
 * Reject any key we do not understand.
 *
 * Without this, `payees: { allow: [...], deny: [...] }` loads cleanly and denies
 * nobody; `max_payments_per_day` under the wrong parent silently enforces
 * nothing. A key that is read but not understood is a limit the author believes
 * is in force and is not — which is exactly the failure this loader claims to
 * prevent.
 */
function only(v: unknown, path: string, allowed: readonly string[]): Raw {
  const o = obj(v, path);
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) {
      throw new PolicyError(
        `${path}.${key}: unknown key. A key that is silently ignored is a limit ` +
          `that is not enforced. Expected one of: ${allowed.join(", ")}`,
      );
    }
  }
  return o;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new PolicyError(`${path}: expected a non-empty string`);
  }
  return v;
}

function int(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new PolicyError(`${path}: expected a non-negative safe integer`);
  }
  return v;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new PolicyError(`${path}: expected an array`);
  return v;
}

function address(v: unknown, path: string): string {
  const s = str(v, path);
  if (!ADDRESS.test(s)) throw new PolicyError(`${path}: not a 0x address: ${s}`);
  return s.toLowerCase();
}

function amount(v: unknown, path: string, decimals: number): bigint {
  const s = str(v, path);
  try {
    const parsed = parseDecimal(s, decimals);
    if (parsed > UINT256_MAX) {
      throw new PolicyError(`${path}: amount exceeds unsigned uint256 range`);
    }
    return parsed;
  } catch (e) {
    // Surface the real reason — "1.0000005 has 7 decimal places, exceeds scale
    // 6" is actionable; "invalid policy" is not.
    if (e instanceof PolicyError) throw e;
    throw new PolicyError(`${path}: ${(e as AmountError).message}`);
  }
}

function timestamp(v: unknown, path: string): number {
  const s = str(v, path);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new PolicyError(`${path}: not a date: ${s}`);
  return ms;
}

/**
 * Validate a parsed policy document.
 *
 * `now` is injected so an already-expired mandate is caught at load rather than
 * at the first payment — you want to know the policy is dead before the agent
 * starts, not when it tries to buy something.
 */
export function loadPolicy(doc: unknown, now: number): LoadedPolicy {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new PolicyError("now: expected a non-negative safe unix-millisecond integer");
  }
  const root = only(doc, "policy", ["policy","version","asset","mandate","payees","payments","budgets","velocity"]);

  const assetRaw = only(root["asset"], "asset", ["symbol","address","network","decimals"]);
  const decimals = int(assetRaw["decimals"], "asset.decimals");
  const network = str(assetRaw["network"], "asset.network");
  if (!CAIP2.test(network)) {
    throw new PolicyError(`asset.network: not a CAIP-2 id (e.g. "eip155:84532"): ${network}`);
  }

  const asset: Policy["asset"] = {
    symbol: str(assetRaw["symbol"], "asset.symbol"),
    address: address(assetRaw["address"], "asset.address"),
    network,
    decimals,
  };
  if (asset.network !== SETTLEMENT_PROFILE.network) {
    throw new PolicyError(
      `asset.network: version 0.1 supports only ${SETTLEMENT_PROFILE.network}`,
    );
  }
  if (asset.address.toLowerCase() !== SETTLEMENT_PROFILE.asset.toLowerCase()) {
    throw new PolicyError(
      `asset.address: version 0.1 supports only Circle Base Sepolia USDC ${SETTLEMENT_PROFILE.asset}`,
    );
  }
  if (asset.decimals !== SETTLEMENT_PROFILE.decimals) {
    throw new PolicyError(
      `asset.decimals: version 0.1 requires ${SETTLEMENT_PROFILE.decimals}`,
    );
  }

  const mandateRaw = only(root["mandate"], "mandate", ["holder","agent","expires"]);
  const expires = timestamp(mandateRaw["expires"], "mandate.expires");
  if (expires <= now) {
    throw new PolicyError(
      `mandate.expires: already expired at ${new Date(expires).toISOString()}`,
    );
  }
  const mandate: Policy["mandate"] = {
    holder: str(mandateRaw["holder"], "mandate.holder"),
    agent: str(mandateRaw["agent"], "mandate.agent"),
    expires,
  };

  const payeesRaw = arr(only(root["payees"], "payees", ["allow"])["allow"], "payees.allow");
  if (payeesRaw.length === 0) {
    // An empty allowlist is default-deny taken to its conclusion: the agent can
    // pay nobody. That is almost certainly an authoring mistake, and a policy
    // that silently blocks everything is as broken as one that allows
    // everything — it just fails in the direction you notice later.
    throw new PolicyError("payees.allow: empty — the agent could pay nobody");
  }
  const payees: Payee[] = payeesRaw.map((p, i) => {
    const o = only(p, `payees.allow[${i}]`, ["name","address"]);
    return {
      name: str(o["name"], `payees.allow[${i}].name`),
      address: address(o["address"], `payees.allow[${i}].address`),
    };
  });

  const paymentsRaw = only(root["payments"], "payments", ["max_per_payment","require_approval_over"]);
  const maxPerPayment = amount(paymentsRaw["max_per_payment"], "payments.max_per_payment", decimals);
  const requireApprovalOver = amount(
    paymentsRaw["require_approval_over"],
    "payments.require_approval_over",
    decimals,
  );
  if (requireApprovalOver > maxPerPayment) {
    // The advisory approval tier would be unreachable: anything big enough to
    // require caller attestation is already denied by the per-payment cap.
    throw new PolicyError(
      `payments.require_approval_over exceeds payments.max_per_payment — ` +
        `no payment could ever reach the approval tier`,
    );
  }

  const budgetsRaw = arr(root["budgets"], "budgets");
  if (budgetsRaw.length === 0) {
    throw new PolicyError("budgets: at least one budget is required");
  }
  const seen = new Set<string>();
  const budgets: Budget[] = budgetsRaw.map((b, i) => {
    const o = only(b, `budgets[${i}]`, ["name","window","limit"]);
    const name = str(o["name"], `budgets[${i}].name`);
    if (seen.has(name)) {
      // Two budgets with one name: the ledger keys committed spend by name, so
      // one would shadow the other and its limit would never be enforced.
      throw new PolicyError(`budgets[${i}].name: duplicate budget name "${name}"`);
    }
    seen.add(name);

    const window = str(o["window"], `budgets[${i}].window`);
    if (!WINDOWS.includes(window as BudgetWindow)) {
      throw new PolicyError(
        `budgets[${i}].window: expected one of ${WINDOWS.join(", ")}, got "${window}"`,
      );
    }
    const limit = amount(o["limit"], `budgets[${i}].limit`, decimals);
    if (limit < maxPerPayment) {
      // A single allowed payment could exceed the budget. Not strictly
      // unsound — the budget clause would deny it — but it means the
      // per-payment cap is a lie, and the author almost certainly meant
      // otherwise. Circle's agent wallets enforce the same ordering.
      throw new PolicyError(
        `budgets[${i}].limit is below payments.max_per_payment — ` +
          `a single permitted payment would exceed the budget`,
      );
    }
    return { name, window: window as BudgetWindow, limit };
  });

  const velocityRaw = only(root["velocity"], "velocity", ["max_payments_per_hour"]);
  const maxPaymentsPerHour = int(
    velocityRaw["max_payments_per_hour"],
    "velocity.max_payments_per_hour",
  );
  if (maxPaymentsPerHour === 0) {
    throw new PolicyError("velocity.max_payments_per_hour: 0 would block every payment");
  }

  const policy: Policy = deepFreeze({
    name: str(root["policy"], "policy"),
    version: int(root["version"], "version"),
    asset,
    mandate,
    payees,
    payments: { maxPerPayment, requireApprovalOver },
    budgets,
    velocity: { maxPaymentsPerHour },
  });

  const loaded = deepFreeze({
    policy,
    hash: hashPolicy(policy),
    [LOADED_POLICY]: true as const,
  });
  loadedPolicies.add(loaded);
  return loaded;
}

/**
 * Content hash of the policy document.
 *
 * Canonical form: keys sorted recursively, no whitespace. Reformatting the file
 * or reordering its keys does not change the hash; changing a limit does.
 */
export function hashPolicy(policy: Policy): string {
  const digest = createHash("sha256").update(canonicalize(policy)).digest("hex");
  return `sha256:${digest}`;
}

function canonicalize(v: unknown): string {
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const entries = Object.entries(v as Raw)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalize(val)}`).join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

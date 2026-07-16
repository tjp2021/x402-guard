/**
 * Fail-closed x402 client hooks for the one settlement rail supported by v0.1.
 *
 * A hook callback is evidence about protocol progress, not settlement proof:
 *
 * - before creation reserves budget before signing;
 * - after creation durably binds the EIP-3009 authorization to that hold;
 * - a generic creation failure stays committed because another hook or
 *   extension may have failed after a payload was signed;
 * - facilitator success is recorded only as a transaction hint, then the Guard
 *   asks the finalized-chain reader for exact nonce/token/from/to/value proof.
 *
 * No upstream Error text or hostile challenge value crosses into abort reasons
 * or the durable ledger.
 */

import type { Guard } from "../guard.js";
import { SETTLEMENT_PROFILE, type Quote } from "../policy.js";

/** Structural subsets of @x402/core v2 hook contexts. */
interface PaymentRequirements {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds?: unknown;
  readonly extra?: unknown;
}

interface PaymentRequired {
  readonly x402Version: number;
  readonly resource: { readonly url?: string };
  readonly accepts: readonly PaymentRequirements[];
  readonly extensions?: unknown;
}

interface PaymentPayload {
  readonly x402Version: number;
  readonly resource?: unknown;
  readonly accepted: PaymentRequirements;
  readonly payload: Record<string, unknown>;
  readonly extensions?: unknown;
}

interface BeforeContext {
  readonly paymentRequired: PaymentRequired;
  readonly selectedRequirements: PaymentRequirements;
}

interface AfterContext extends BeforeContext {
  readonly paymentPayload: PaymentPayload;
}

interface FailureContext extends BeforeContext {
  readonly error: Error;
}

interface ResponseContext {
  readonly paymentPayload: PaymentPayload;
  readonly requirements: PaymentRequirements;
  readonly settleResponse?: {
    readonly success: boolean;
    readonly transaction: string;
    readonly payer?: string;
  };
  readonly error?: Error;
}

interface Eip3009Authorization {
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
  readonly validAfter: bigint;
  /** Canonical EIP-3009 unix seconds, preserved losslessly. */
  readonly validBefore: bigint;
  readonly nonce: string;
}

interface PendingHold {
  readonly holdId: string;
  readonly amount: bigint;
  readonly payTo: string;
  readonly requirements: PaymentRequirements;
  readonly paymentRequired: PaymentRequired;
  readonly resource: object;
  readonly extensions: object | undefined;
}

export interface X402GuardHooks {
  onBeforePaymentCreation: (
    ctx: BeforeContext,
  ) => Promise<void | { abort: true; reason: string }>;
  onAfterPaymentCreation: (ctx: AfterContext) => Promise<void>;
  onPaymentResponse: (ctx: ResponseContext) => Promise<void>;
  onPaymentCreationFailure: (ctx: FailureContext) => Promise<never>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const CANONICAL_UNSIGNED = /^(0|[1-9][0-9]*)$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT256_DECIMAL_DIGITS = 78;
const MAX_RESOURCE_BYTES = 8_192;
const MAX_SIGNATURE_BYTES = 8_192;
const REQUIREMENT_KEYS = new Set([
  "scheme",
  "network",
  "asset",
  "amount",
  "payTo",
  "maxTimeoutSeconds",
  "extra",
]);
const PAYMENT_REQUIRED_KEYS = new Set([
  "x402Version",
  "error",
  "resource",
  "accepts",
  "extensions",
]);
const RESOURCE_KEYS = new Set([
  "url",
  "description",
  "mimeType",
  "serviceName",
  "tags",
  "iconUrl",
]);
const PAYLOAD_KEYS = new Set([
  "x402Version",
  "resource",
  "accepted",
  "payload",
  "extensions",
]);
const INNER_PAYLOAD_KEYS = new Set(["authorization", "signature"]);
const AUTHORIZATION_KEYS = new Set([
  "from",
  "to",
  "value",
  "validAfter",
  "validBefore",
  "nonce",
]);

const ABORT = Object.freeze({
  unsupportedScheme: "x402-guard: unsupported settlement scheme",
  unsupportedRail: "x402-guard: unsupported settlement rail",
  malformedChallenge: "x402-guard: malformed payment challenge",
});

/** A bounded terminal error used after signing may have started. */
export class X402GuardLifecycleError extends Error {
  constructor() {
    super("x402-guard: payment creation quarantined");
    this.name = "X402GuardLifecycleError";
  }
}

/** Build hooks suitable for direct registration on an @x402/core v2 client. */
export function x402GuardHooks(guard: Guard): X402GuardHooks {
  // The SDK threads the selected requirements object through before/after.
  const holdByRequirements = new WeakMap<object, PendingHold>();
  // Guard permits only one unsigned authority-bearing flight. This fallback
  // lets a corrupted hook context quarantine that flight instead of losing the
  // WeakMap key and accidentally allowing the request to continue.
  let activePending: PendingHold | undefined;
  // The signed EIP-3009 nonce correlates after/response. Durable reconciliation
  // does not depend on this in-memory map after authorization is attached.
  const holdByNonce = new Map<string, PendingHold>();

  return {
    async onBeforePaymentCreation(ctx) {
      const prepared = preparePreSignContext(ctx);
      if (!prepared) {
        return { abort: true, reason: ABORT.malformedChallenge };
      }
      const { req, required } = prepared;
      if (req.scheme !== SETTLEMENT_PROFILE.scheme) {
        return { abort: true, reason: ABORT.unsupportedScheme };
      }
      if (
        req.network !== SETTLEMENT_PROFILE.network ||
        typeof req.asset !== "string" ||
        req.asset.toLowerCase() !== SETTLEMENT_PROFILE.asset.toLowerCase() ||
        !isPinnedEip3009Extra(req.extra)
      ) {
        return { abort: true, reason: ABORT.unsupportedRail };
      }
      if (
        typeof req.maxTimeoutSeconds !== "number" ||
        !Number.isSafeInteger(req.maxTimeoutSeconds) ||
        req.maxTimeoutSeconds <= 0 ||
        req.maxTimeoutSeconds > 3_600
      ) {
        return { abort: true, reason: ABORT.malformedChallenge };
      }

      const quote = toQuote(required, req);
      if (!quote) {
        return { abort: true, reason: ABORT.malformedChallenge };
      }

      const authorization = await guard.authorize(quote);
      if (authorization.decision !== "allow") {
        return {
          abort: true,
          reason: `x402-guard: policy ${authorization.verdict.reason}`,
        };
      }

      const pending = Object.freeze({
        holdId: authorization.holdId,
        amount: quote.amount,
        payTo: quote.payTo,
        requirements: req,
        paymentRequired: required,
        resource: required.resource as object,
        extensions: required.extensions as object | undefined,
      });
      holdByRequirements.set(req, pending);
      activePending = pending;
    },

    async onAfterPaymentCreation(ctx) {
      let requirements: object | undefined;
      try {
        requirements = ownDataValue(ctx, "selectedRequirements") as
          | object
          | undefined;
      } catch {
        requirements = undefined;
      }
      const pending =
        (requirements && holdByRequirements.get(requirements)) || activePending;
      if (!pending) return;
      holdByRequirements.delete(pending.requirements);
      if (activePending === pending) activePending = undefined;

      let authorization: Eip3009Authorization | undefined;
      try {
        authorization = freezeAndReadPaymentPayload(ctx, pending);
      } catch {
        authorization = undefined;
      }
      if (!authorization || !matchesPending(authorization, pending)) {
        try {
          await guard.markCreationIndeterminate(
            pending.holdId,
            "authorization_unreadable",
          );
        } catch {
          // A durable append failure leaves the original held entry in place;
          // held entries also block all new authority.
        }
        throw new X402GuardLifecycleError();
      }

      await guard.attachAuthorization(
        pending.holdId,
        authorization.nonce,
        authorization.from,
        authorization.validBefore,
      );
      holdByNonce.set(authorization.nonce, pending);
    },

    async onPaymentCreationFailure(ctx) {
      let requirements: object | undefined;
      try {
        requirements = ownDataValue(ctx, "selectedRequirements") as
          | object
          | undefined;
      } catch {
        requirements = undefined;
      }
      const pending =
        (requirements && holdByRequirements.get(requirements)) || activePending;
      if (pending) {
        holdByRequirements.delete(pending.requirements);
        if (activePending === pending) activePending = undefined;

        // This callback covers failures beyond signing itself. It cannot attest
        // that no signed payload exists, so it has no release authority.
        try {
          await guard.markCreationIndeterminate(
            pending.holdId,
            "creation_outcome_unknown",
          );
        } catch {
          // The original held entry remains a global authority lock.
        }
      }

      // The installed core accepts the first later hook that returns a recovered
      // payload. Throwing here is therefore part of the security boundary: this
      // hook must be registered before every other failure hook.
      throw new X402GuardLifecycleError();
    },

    async onPaymentResponse(ctx) {
      let authorization: Eip3009Authorization | undefined;
      try {
        const payload = payloadRecord(ctx.paymentPayload);
        authorization = payload && readAuthorization(payload);
      } catch {
        return;
      }
      if (!authorization) return;

      const pending = holdByNonce.get(authorization.nonce);
      if (!pending) return;

      const response = ctx.settleResponse;
      if (
        matchesPending(authorization, pending) &&
        response?.success === true &&
        typeof response.transaction === "string" &&
        HASH32.test(response.transaction)
      ) {
        // reportSettlement persists a nonterminal hint and immediately invokes
        // finalized exact-chain reconciliation. The hint can never settle.
        await guard.reportSettlement(pending.holdId, response.transaction);
      } else {
        // Failure, malformed success, or a transport/verify response still
        // leaves a signed authorization. Ask the same proof path directly.
        await guard.reconcileHold(pending.holdId);
      }

      holdByNonce.delete(authorization.nonce);
    },
  };
}

/**
 * Validate and freeze every SDK object whose value is reused after this hook.
 * There is deliberately no await in this function: once it returns, later
 * hooks cannot change the challenge that Guard authorized.
 */
function preparePreSignContext(
  context: unknown,
): { req: PaymentRequirements; required: PaymentRequired } | undefined {
  try {
    const contextValues = readPlainDataRecord(
      context,
      new Set(["paymentRequired", "selectedRequirements"]),
      ["paymentRequired", "selectedRequirements"],
    );
    if (!contextValues) return undefined;

    const req = contextValues["selectedRequirements"];
    const required = contextValues["paymentRequired"];
    const reqValues = readPlainDataRecord(
      req,
      REQUIREMENT_KEYS,
      [...REQUIREMENT_KEYS],
    );
    const requiredValues = readPlainDataRecord(
      required,
      PAYMENT_REQUIRED_KEYS,
      ["x402Version", "resource", "accepts"],
    );
    if (!reqValues || !requiredValues) return undefined;

    const extra = reqValues["extra"];
    if (
      !readPlainDataRecord(
        extra,
        new Set(["name", "version", "assetTransferMethod"]),
        ["name", "version"],
      )
    ) {
      return undefined;
    }

    const resource = requiredValues["resource"];
    const resourceValues = readPlainDataRecord(resource, RESOURCE_KEYS, ["url"]);
    if (!resourceValues || !validResourceMetadata(resourceValues)) return undefined;

    const accepts = requiredValues["accepts"];
    const acceptedValues = readDataArray(accepts);
    if (
      !acceptedValues ||
      acceptedValues.length === 0 ||
      !acceptedValues.some((candidate) => candidate === req)
    ) {
      return undefined;
    }

    const tags = resourceValues["tags"];
    if (tags !== undefined) {
      const tagValues = readDataArray(tags);
      if (!tagValues || tagValues.some((tag) => typeof tag !== "string")) {
        return undefined;
      }
      Object.freeze(tags);
    }

    let extensions: unknown;
    if (Object.prototype.hasOwnProperty.call(requiredValues, "extensions")) {
      extensions = requiredValues["extensions"];
      const extensionValues = readPlainDataRecord(extensions, new Set(), []);
      if (!extensionValues) return undefined;
      Object.freeze(extensions);
    }

    // Freeze bottom-up, then re-read every descriptor. A transparent Proxy can
    // no longer report changing values once its target is non-extensible with
    // non-writable data properties.
    Object.freeze(extra);
    Object.freeze(resource);
    Object.freeze(accepts);
    Object.freeze(req);
    Object.freeze(required);
    Object.freeze(context);

    const finalContext = readPlainDataRecord(
      context,
      new Set(["paymentRequired", "selectedRequirements"]),
      ["paymentRequired", "selectedRequirements"],
    );
    const finalReq = readPlainDataRecord(
      req,
      REQUIREMENT_KEYS,
      [...REQUIREMENT_KEYS],
    );
    const finalRequired = readPlainDataRecord(
      required,
      PAYMENT_REQUIRED_KEYS,
      ["x402Version", "resource", "accepts"],
    );
    const finalExtra = readPlainDataRecord(
      extra,
      new Set(["name", "version", "assetTransferMethod"]),
      ["name", "version"],
    );
    const finalResource = readPlainDataRecord(resource, RESOURCE_KEYS, ["url"]);
    const finalAccepts = readDataArray(accepts);
    if (
      !finalContext ||
      !finalReq ||
      !finalRequired ||
      !finalExtra ||
      !finalResource ||
      !finalAccepts ||
      finalContext["selectedRequirements"] !== req ||
      finalContext["paymentRequired"] !== required ||
      finalReq["extra"] !== extra ||
      finalRequired["resource"] !== resource ||
      finalRequired["accepts"] !== accepts ||
      finalRequired["x402Version"] !== 2 ||
      !finalAccepts.some((candidate) => candidate === req) ||
      !validResourceMetadata(finalResource)
    ) {
      return undefined;
    }
    if (extensions !== undefined) {
      if (
        finalRequired["extensions"] !== extensions ||
        !readPlainDataRecord(extensions, new Set(), [])
      ) {
        return undefined;
      }
    } else if (Object.prototype.hasOwnProperty.call(finalRequired, "extensions")) {
      return undefined;
    }

    return {
      req: req as PaymentRequirements,
      required: required as PaymentRequired,
    };
  } catch {
    return undefined;
  }
}

/** Validate/freeze the exact installed-core EIP-3009 payload graph. */
function freezeAndReadPaymentPayload(
  context: unknown,
  pending: PendingHold,
): Eip3009Authorization | undefined {
  const contextValues = readPlainDataRecord(
    context,
    new Set(["paymentRequired", "selectedRequirements", "paymentPayload"]),
    ["paymentRequired", "selectedRequirements", "paymentPayload"],
  );
  if (
    !contextValues ||
    contextValues["selectedRequirements"] !== pending.requirements ||
    contextValues["paymentRequired"] !== pending.paymentRequired
  ) {
    return undefined;
  }

  const outer = contextValues["paymentPayload"];
  const outerValues = readPlainDataRecord(
    outer,
    PAYLOAD_KEYS,
    ["x402Version", "resource", "accepted", "payload"],
  );
  if (
    !outerValues ||
    outerValues["x402Version"] !== 2 ||
    outerValues["accepted"] !== pending.requirements ||
    outerValues["resource"] !== pending.resource
  ) {
    return undefined;
  }

  const hasOuterExtensions = Object.prototype.hasOwnProperty.call(
    outerValues,
    "extensions",
  );
  const outerExtensions = outerValues["extensions"];
  if (pending.extensions === undefined) {
    if (hasOuterExtensions && outerExtensions !== undefined) return undefined;
  } else if (outerExtensions !== pending.extensions) {
    return undefined;
  }

  const inner = outerValues["payload"];
  const innerValues = readPlainDataRecord(
    inner,
    INNER_PAYLOAD_KEYS,
    [...INNER_PAYLOAD_KEYS],
  );
  if (!innerValues || !isBoundedEvenHex(innerValues["signature"])) {
    return undefined;
  }

  const authorization = innerValues["authorization"];
  if (
    !readPlainDataRecord(
      authorization,
      AUTHORIZATION_KEYS,
      [...AUTHORIZATION_KEYS],
    )
  ) {
    return undefined;
  }

  Object.freeze(authorization);
  Object.freeze(inner);
  Object.freeze(pending.resource);
  if (pending.extensions) Object.freeze(pending.extensions);
  Object.freeze(outer);
  Object.freeze(context);

  const finalContext = readPlainDataRecord(
    context,
    new Set(["paymentRequired", "selectedRequirements", "paymentPayload"]),
    ["paymentRequired", "selectedRequirements", "paymentPayload"],
  );
  const finalOuter = readPlainDataRecord(
    outer,
    PAYLOAD_KEYS,
    ["x402Version", "resource", "accepted", "payload"],
  );
  const finalInner = readPlainDataRecord(
    inner,
    INNER_PAYLOAD_KEYS,
    [...INNER_PAYLOAD_KEYS],
  );
  if (
    !finalContext ||
    !finalOuter ||
    !finalInner ||
    finalContext["paymentPayload"] !== outer ||
    finalContext["selectedRequirements"] !== pending.requirements ||
    finalContext["paymentRequired"] !== pending.paymentRequired ||
    finalOuter["x402Version"] !== 2 ||
    finalOuter["resource"] !== pending.resource ||
    finalOuter["accepted"] !== pending.requirements ||
    finalOuter["payload"] !== inner ||
    finalInner["authorization"] !== authorization ||
    !isBoundedEvenHex(finalInner["signature"]) ||
    !readPlainDataRecord(
      authorization,
      AUTHORIZATION_KEYS,
      [...AUTHORIZATION_KEYS],
    )
  ) {
    return undefined;
  }
  if (pending.extensions === undefined) {
    if (
      Object.prototype.hasOwnProperty.call(finalOuter, "extensions") &&
      finalOuter["extensions"] !== undefined
    ) {
      return undefined;
    }
  } else if (finalOuter["extensions"] !== pending.extensions) {
    return undefined;
  }

  return readAuthorization(inner as Record<string, unknown>);
}

function readPlainDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
    requiredKeys.some((key) => !keys.includes(key))
  ) {
    return undefined;
  }

  const out: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      descriptor?.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return undefined;
    }
    out[key] = descriptor.value;
  }
  return out;
}

function readDataArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return undefined;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)) return undefined;
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) return undefined;

  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length")) return undefined;
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      return undefined;
    }
    out.push(descriptor.value);
  }
  return out;
}

function validResourceMetadata(values: Record<string, unknown>): boolean {
  if (typeof values["url"] !== "string") return false;
  for (const key of ["description", "mimeType", "serviceName", "iconUrl"]) {
    if (
      Object.prototype.hasOwnProperty.call(values, key) &&
      typeof values[key] !== "string"
    ) {
      return false;
    }
  }
  return true;
}

function ownDataValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid hook context");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor?.enumerable !== true || !("value" in descriptor)) {
    throw new TypeError("invalid hook context");
  }
  return descriptor.value;
}

function isBoundedEvenHex(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 2 + MAX_SIGNATURE_BYTES * 2 ||
    !value.startsWith("0x") ||
    (value.length - 2) % 2 !== 0
  ) {
    return false;
  }
  for (let index = 2; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const digit = code >= 48 && code <= 57;
    const lower = code >= 97 && code <= 102;
    const upper = code >= 65 && code <= 70;
    if (!digit && !lower && !upper) return false;
  }
  return true;
}

function toQuote(
  required: PaymentRequired,
  req: PaymentRequirements,
): Quote | undefined {
  const amount = parseCanonicalUint256(req.amount);
  if (
    amount === undefined ||
    typeof req.payTo !== "string" ||
    !ADDRESS.test(req.payTo)
  ) {
    return undefined;
  }

  if (!isRecord(required.resource)) return undefined;
  const resource = required.resource.url;
  if (
    typeof resource !== "string" ||
    resource.length === 0 ||
    Buffer.byteLength(resource, "utf8") > MAX_RESOURCE_BYTES
  ) {
    return undefined;
  }

  return Object.freeze({
    amount,
    asset: req.asset,
    network: req.network,
    payTo: req.payTo,
    resource,
  });
}

/** Pull and strictly validate the EIP-3009 authorization. */
function readAuthorization(
  payload: Record<string, unknown>,
): Eip3009Authorization | undefined {
  const candidate = payload["authorization"];
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return undefined;
  }

  const authorization = candidate as Record<string, unknown>;
  const from = authorization["from"];
  const to = authorization["to"];
  const value = parseCanonicalUint256(authorization["value"]);
  const validAfter = parseCanonicalUint256(authorization["validAfter"]);
  const nonce = authorization["nonce"];
  const validBefore = authorization["validBefore"];
  if (
    typeof from !== "string" ||
    !ADDRESS.test(from) ||
    typeof to !== "string" ||
    !ADDRESS.test(to) ||
    value === undefined ||
    validAfter !== 0n ||
    typeof nonce !== "string" ||
    !HASH32.test(nonce) ||
    parseCanonicalUint256(validBefore) === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    from,
    to,
    value,
    validAfter,
    nonce: nonce.toLowerCase(),
    validBefore: parseCanonicalUint256(validBefore)!,
  });
}

function matchesPending(
  authorization: Eip3009Authorization,
  pending: PendingHold,
): boolean {
  return (
    authorization.to.toLowerCase() === pending.payTo.toLowerCase() &&
    authorization.value === pending.amount &&
    authorization.validAfter === 0n
  );
}

function parseCanonicalUint256(value: unknown): bigint | undefined {
  if (
    typeof value !== "string" ||
    value.length > MAX_UINT256_DECIMAL_DIGITS ||
    !CANONICAL_UNSIGNED.test(value)
  ) {
    return undefined;
  }
  const parsed = BigInt(value);
  return parsed <= MAX_UINT256 ? parsed : undefined;
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const inner = payload["payload"];
  return isRecord(inner) ? inner : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPinnedEip3009Extra(value: unknown): boolean {
  try {
    if (!isPlainDataRecord(value)) return false;
    const allowed = new Set(["name", "version", "assetTransferMethod"]);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      value["name"] !== "USDC" ||
      value["version"] !== "2"
    ) {
      return false;
    }
    return (
      !Object.prototype.hasOwnProperty.call(value, "assetTransferMethod") ||
      value["assetTransferMethod"] === "eip3009"
    );
  } catch {
    return false;
  }
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}

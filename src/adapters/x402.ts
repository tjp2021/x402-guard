/**
 * The x402 adapter — the glue between the Guard and the real @x402/core client.
 *
 * This is the file the whole library was built toward: it wires the stateful
 * gate into x402's own payment lifecycle hooks. Register it on an `x402Client`
 * and every payment that client makes is checked against the policy, reserved
 * against the budget, and reconciled against the chain.
 *
 * The three hooks and how they map:
 *
 *   onBeforePaymentCreation  → authorize   (evaluate + reserve, before signing)
 *   onAfterPaymentCreation   → attach      (capture nonce + validBefore, after signing)
 *   onPaymentResponse        → confirm     (record the settlement tx)
 *   onPaymentCreationFailure → abandon     (signing failed; no payload exists)
 *
 * Correlation across the hooks, without guessing:
 *
 *   before → after : the SDK passes the SAME `selectedRequirements` object
 *     through both hooks of one payment, so a WeakMap keyed on that object
 *     identity links them. Concurrency-safe — each payment selects its own.
 *   after  → response : both carry the payload, and its EIP-3009 nonce is
 *     unique per authorization, so a Map keyed on the nonce links them.
 *
 * The adapter is deliberately scheme-aware for the `exact` EVM scheme (EIP-3009
 * transferWithAuthorization, which is how x402 settles USDC). A payment in an
 * unrecognized scheme is denied rather than waved through — failing closed at
 * the one boundary that faces a scheme we cannot reason about.
 */

import type { Guard } from "../guard.js";
import type { Quote } from "../policy.js";

/** The subset of the @x402/core hook contexts this adapter reads. Structural — no import needed. */
interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}
interface PaymentRequired {
  resource: { url?: string } | undefined;
  accepts: PaymentRequirements[];
}
interface BeforeContext {
  paymentRequired: PaymentRequired;
  selectedRequirements: PaymentRequirements;
}
interface AfterContext extends BeforeContext {
  paymentPayload: { payload: Record<string, unknown> };
}
interface FailureContext extends BeforeContext {
  error: Error;
}
interface ResponseContext {
  paymentPayload: { payload: Record<string, unknown> };
  settleResponse?: { success: boolean; transaction: string; payer?: string };
  error?: Error;
}

/** The EIP-3009 authorization inside an `exact`-scheme EVM payload. */
interface Eip3009Authorization {
  from: string;
  validBefore: string; // unix SECONDS as a string
  nonce: string;
}

export interface X402GuardHooks {
  onBeforePaymentCreation: (ctx: BeforeContext) => Promise<void | { abort: true; reason: string }>;
  onAfterPaymentCreation: (ctx: AfterContext) => Promise<void>;
  onPaymentResponse: (ctx: ResponseContext) => Promise<void>;
  onPaymentCreationFailure: (ctx: FailureContext) => Promise<void>;
}

/**
 * Build the hook bundle for a Guard. Register the returned hooks on an
 * `x402Client`:
 *
 *   const hooks = x402GuardHooks(guard);
 *   client
 *     .onBeforePaymentCreation(hooks.onBeforePaymentCreation)
 *     .onAfterPaymentCreation(hooks.onAfterPaymentCreation)
 *     .onPaymentResponse(hooks.onPaymentResponse)
 *     .onPaymentCreationFailure(hooks.onPaymentCreationFailure);
 */
export function x402GuardHooks(guard: Guard): X402GuardHooks {
  // before → after: hold id by the requirements object the SDK threads through.
  const holdByRequirements = new WeakMap<object, string>();
  // after → response: hold id by the unique EIP-3009 nonce. Drained in
  // onPaymentResponse; a payment whose response hook never fires (dropped or
  // crashed after signing) leaks its entry. Bounded in practice by the payments
  // in flight in one agent session — a long-lived, multi-tenant host should wrap
  // this with a TTL or size cap. (The hold itself is not lost: the reconciler
  // still resolves it against the chain from the durable ledger.)
  const holdByNonce = new Map<string, string>();

  return {
    async onBeforePaymentCreation(ctx) {
      const req = ctx.selectedRequirements;
      if (req.scheme !== "exact") {
        // We only understand the exact/EIP-3009 scheme's payload. Anything else
        // we cannot reconcile against the chain, so we do not authorize it.
        return { abort: true, reason: `x402-guard: unsupported scheme "${req.scheme}"` };
      }

      let quote;
      try {
        quote = toQuote(ctx.paymentRequired, req);
      } catch {
        // A malformed amount from a hostile 402 must not throw out of the hook.
        // Abort cleanly — the payment is never signed either way.
        return { abort: true, reason: `x402-guard: unparseable payment amount "${req.amount}"` };
      }
      const auth = await guard.authorize(quote);

      if (auth.decision !== "allow") {
        return { abort: true, reason: `x402-guard: ${auth.verdict.reason} (${auth.verdict.clause})` };
      }
      holdByRequirements.set(req, auth.holdId);
      // void: allow payment creation to proceed.
    },

    async onAfterPaymentCreation(ctx) {
      const holdId = holdByRequirements.get(ctx.selectedRequirements);
      if (!holdId) return; // not a payment we authorized

      const authz = readAuthorization(ctx.paymentPayload.payload);
      if (!authz) {
        // The payload is signed but we cannot read its authorization. We cannot
        // attach a nonce, so this hold stays nonce-less and the reconciler will
        // flag it rather than release it — fail safe, not silent.
        return;
      }

      // validBefore is unix seconds in the payload; the ledger works in ms.
      const validBeforeMs = Number(authz.validBefore) * 1000;
      await guard.attachAuthorization(holdId, authz.nonce, authz.from, validBeforeMs);
      holdByNonce.set(authz.nonce, holdId);
    },

    async onPaymentResponse(ctx) {
      const authz = readAuthorization(ctx.paymentPayload.payload);
      if (!authz) return;
      const holdId = holdByNonce.get(authz.nonce);
      if (!holdId) return;
      holdByNonce.delete(authz.nonce);

      if (ctx.settleResponse?.success) {
        await guard.confirm(holdId, ctx.settleResponse.transaction);
      }
      // On failure we do NOT release here: the signed authorization may still be
      // submittable, so the reconciler resolves it against the chain under the
      // validBefore rule. Releasing on an error response is the double-spend.
    },

    async onPaymentCreationFailure(ctx) {
      const holdId = holdByRequirements.get(ctx.selectedRequirements);
      if (!holdId) return;
      // Signing failed, so no payload was ever produced — nothing can settle.
      // This is the affirmative "never signed" signal that lets the budget go.
      await guard.abandon(holdId, `x402-guard: payment creation failed — ${ctx.error.message}`);
    },
  };
}

function toQuote(required: PaymentRequired, req: PaymentRequirements): Quote {
  return {
    amount: BigInt(req.amount),
    asset: req.asset,
    network: req.network,
    payTo: req.payTo,
    resource: required.resource?.url ?? "",
  };
}

/** Pull the EIP-3009 authorization out of an exact-scheme EVM payload. */
function readAuthorization(payload: Record<string, unknown>): Eip3009Authorization | undefined {
  const a = payload["authorization"];
  if (typeof a !== "object" || a === null) return undefined;
  const o = a as Record<string, unknown>;
  if (
    typeof o["from"] !== "string" ||
    typeof o["validBefore"] !== "string" ||
    typeof o["nonce"] !== "string"
  ) {
    return undefined;
  }
  // validBefore must parse to a finite number of seconds. A malformed value
  // becomes NaN downstream, and a NaN deadline makes the reconciler's release
  // rule fail unsafe (`now <= NaN` is false → release). Refuse to read the
  // authorization rather than admit a deadline we cannot reason about — the hold
  // then stays nonce-less and the reconciler flags it instead of releasing.
  if (!Number.isFinite(Number(o["validBefore"]))) return undefined;
  return { from: o["from"], validBefore: o["validBefore"], nonce: o["nonce"] };
}

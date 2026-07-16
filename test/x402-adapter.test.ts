import { describe, expect, it, vi } from "vitest";
import type {
  AfterPaymentCreationHook,
  BeforePaymentCreationHook,
  OnPaymentCreationFailureHook,
  OnPaymentResponseHook,
} from "@x402/core/client";
import {
  X402GuardLifecycleError,
  x402GuardHooks,
} from "../src/adapters/x402.js";
import { AuthorityExposureError, Guard } from "../src/guard.js";
import type { Entry } from "../src/ledger.js";
import { loadPolicy } from "../src/load.js";
import { SETTLEMENT_PROFILE } from "../src/policy.js";
import type {
  ChainReader,
  Clock,
  LedgerStore,
  PaymentStatus,
} from "../src/ports.js";

const USDC = SETTLEMENT_PROFILE.asset;
const NET = SETTLEMENT_PROFILE.network;
const SELLER = "0xE5f6000000000000000000000000000000007788";
const PAYER = "0xA1b2000000000000000000000000000000001234";
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const NONCE = `0x${"ab".repeat(32)}`;
const HINT_TX = `0x${"cd".repeat(32)}`;
const CHAIN_TX = `0x${"ef".repeat(32)}`;
const UINT256_OVERFLOW = (1n << 256n).toString();

const FINALIZED = Object.freeze({
  chainId: SETTLEMENT_PROFILE.chainId,
  number: 1_000_000n,
  hash: `0x${"12".repeat(32)}`,
  timestamp: BigInt(Math.floor(NOW / 1000) + 600),
});

const POLICY_DOCUMENT = {
  policy: "adapter-test",
  version: 1,
  asset: {
    symbol: "USDC",
    address: USDC,
    network: NET,
    decimals: 6,
  },
  mandate: {
    holder: "research-team",
    agent: "adapter-test",
    expires: "2026-08-01T00:00:00.000Z",
  },
  payees: { allow: [{ name: "Seller", address: SELLER }] },
  payments: {
    max_per_payment: "2.00",
    require_approval_over: "2.00",
  },
  budgets: [{ name: "daily-cap", window: "rolling-24h", limit: "5.00" }],
  velocity: { max_payments_per_hour: 10 },
};

const clock: Clock = { now: () => NOW };

function memoryStore(): LedgerStore & { readonly written: Entry[] } {
  const written: Entry[] = [];
  return {
    written,
    append: async (entry) => {
      written.push(structuredClone(entry));
    },
    readAll: async () => structuredClone(written),
  };
}

function chainSaying(
  answer:
    | PaymentStatus
    | ((params: Parameters<ChainReader["findPayment"]>[0]) => PaymentStatus) = {
      state: "unknown",
      reason: "authorization_still_live",
    },
) {
  const findPayment = vi.fn(async (params: Parameters<ChainReader["findPayment"]>[0]) =>
    typeof answer === "function" ? answer(params) : answer,
  );
  const assertReady = vi.fn(async () => undefined);
  const reader: ChainReader = {
    profile: SETTLEMENT_PROFILE,
    assertReady,
    findPayment,
  };
  return { reader, findPayment, assertReady };
}

async function open(answer?: Parameters<typeof chainSaying>[0]) {
  const store = memoryStore();
  const chain = chainSaying(answer);
  const guard = await Guard.open({
    loadedPolicy: loadPolicy(POLICY_DOCUMENT, NOW),
    store,
    chain: chain.reader,
    clock,
  });
  return { guard, store, chain };
}

function requirements(amount = "1800000") {
  return {
    scheme: "exact",
    network: NET,
    asset: USDC,
    amount,
    payTo: SELLER,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  };
}

type TestRequirements = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: unknown;
  extra: unknown;
};

function paymentRequired(
  req: TestRequirements,
  extensions?: Record<string, unknown>,
) {
  return {
    x402Version: 2,
    resource: { url: "https://api.example/report" },
    accepts: [req],
    ...(extensions === undefined ? {} : { extensions }),
  };
}

function paymentPayload(
  req: TestRequirements,
  required: ReturnType<typeof paymentRequired>,
  overrides: Partial<{
    nonce: unknown;
    validBefore: unknown;
    from: unknown;
    value: unknown;
    to: unknown;
    validAfter: unknown;
    signature: unknown;
  }> = {},
) {
  const value = (key: keyof typeof overrides, fallback: unknown) =>
    Object.prototype.hasOwnProperty.call(overrides, key)
      ? overrides[key]
      : fallback;
  return {
    x402Version: 2,
    resource: required.resource,
    accepted: req,
    extensions: "extensions" in required ? required.extensions : undefined,
    payload: {
      authorization: {
        from: value("from", PAYER),
        to: value("to", SELLER),
        value: value("value", req.amount),
        validAfter: value("validAfter", "0"),
        validBefore: value(
          "validBefore",
          String(Math.floor(NOW / 1000) + 3_600),
        ),
        nonce: value("nonce", NONCE),
      },
      signature: value("signature", `0x${"11".repeat(65)}`),
    },
  };
}

async function authorizeAndAttach(
  hooks: ReturnType<typeof x402GuardHooks>,
  req = requirements(),
  overrides: Parameters<typeof paymentPayload>[2] = {},
) {
  const required = paymentRequired(req);
  const payload = paymentPayload(req, required, overrides);
  const before = await hooks.onBeforePaymentCreation({
    paymentRequired: required,
    selectedRequirements: req,
  });
  expect(before).toBeUndefined();
  await hooks.onAfterPaymentCreation({
    paymentRequired: required,
    selectedRequirements: req,
    paymentPayload: payload,
  });
  return { req, required, payload };
}

async function pay(
  hooks: ReturnType<typeof x402GuardHooks>,
  amount: string,
  nonce: string,
) {
  const req = requirements(amount);
  const required = paymentRequired(req);
  const before = await hooks.onBeforePaymentCreation({
    paymentRequired: required,
    selectedRequirements: req,
  });
  if (before) return { aborted: true as const, reason: before.reason };

  const payload = paymentPayload(req, required, { nonce });
  await hooks.onAfterPaymentCreation({
    paymentRequired: required,
    selectedRequirements: req,
    paymentPayload: payload,
  });
  await hooks.onPaymentResponse({
    paymentPayload: payload,
    requirements: req,
    settleResponse: {
      success: true,
      transaction: nonce,
      payer: PAYER,
    },
  });
  return { aborted: false as const };
}

const jsonSafe = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );

describe("x402 hook compatibility and cumulative policy", () => {
  it("is directly assignable to the installed @x402/core v2 hook types", async () => {
    const { guard } = await open();
    const hooks = x402GuardHooks(guard);
    const before: BeforePaymentCreationHook = hooks.onBeforePaymentCreation;
    const after: AfterPaymentCreationHook = hooks.onAfterPaymentCreation;
    const failure: OnPaymentCreationFailureHook = hooks.onPaymentCreationFailure;
    const response: OnPaymentResponseHook = hooks.onPaymentResponse;
    expect([before, after, failure, response]).toHaveLength(4);
  });

  it("blocks a split-purchase attack while prior signed holds remain unresolved", async () => {
    const { guard } = await open();
    const hooks = x402GuardHooks(guard);

    const first = await pay(hooks, "1800000", `0x${"a1".repeat(32)}`);
    const second = await pay(hooks, "1800000", `0x${"b2".repeat(32)}`);
    const third = await pay(hooks, "1800000", `0x${"c3".repeat(32)}`);

    expect(first.aborted).toBe(false);
    expect(second.aborted).toBe(false);
    expect(third).toEqual({
      aborted: true,
      reason: "x402-guard: policy budget_exceeded",
    });
  });
});

describe("pre-sign SDK boundary", () => {
  it("freezes every challenge object the installed core rereads", async () => {
    const { guard } = await open();
    const hooks = x402GuardHooks(guard);
    const req = requirements();
    const extensions = {};
    const required = paymentRequired(req, extensions);
    const context = {
      paymentRequired: required,
      selectedRequirements: req,
    };

    await expect(hooks.onBeforePaymentCreation(context)).resolves.toBeUndefined();

    for (const value of [
      context,
      req,
      req.extra,
      required,
      required.resource,
      required.accepts,
      extensions,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => {
      req.amount = "1";
    }).toThrow(TypeError);
    expect(() => {
      req.extra.name = "HostileToken";
    }).toThrow(TypeError);
    expect(() => {
      required.resource.url = "https://hostile.invalid";
    }).toThrow(TypeError);
    expect(() => {
      required.accepts.push(requirements("1"));
    }).toThrow(TypeError);
  });

  it("rejects non-v2 challenges and nonempty or hostile extensions without a hold", async () => {
    const hostileExtensions = [
      { recover: "HOSTILE-SECRET" },
      Object.defineProperty({}, "recover", {
        enumerable: true,
        get() {
          throw new Error("HOSTILE-SECRET getter");
        },
      }),
      new Proxy({}, {
        getPrototypeOf() {
          throw new Error("HOSTILE-SECRET proxy");
        },
      }),
    ];

    for (const extensions of hostileExtensions) {
      const { guard } = await open();
      const authorize = vi.spyOn(guard, "authorize");
      const hooks = x402GuardHooks(guard);
      const req = requirements();
      const result = await hooks.onBeforePaymentCreation({
        paymentRequired: { ...paymentRequired(req), extensions },
        selectedRequirements: req,
      });
      expect(result).toEqual({
        abort: true,
        reason: "x402-guard: malformed payment challenge",
      });
      expect(authorize).not.toHaveBeenCalled();
      expect(guard.history()).toHaveLength(0);
    }

    const { guard } = await open();
    const hooks = x402GuardHooks(guard);
    const req = requirements();
    await expect(hooks.onBeforePaymentCreation({
      paymentRequired: { ...paymentRequired(req), x402Version: 1 },
      selectedRequirements: req,
    })).resolves.toEqual({
      abort: true,
      reason: "x402-guard: malformed payment challenge",
    });
    expect(guard.history()).toHaveLength(0);
  });

  it("rejects accessor and non-enumerable requirement fields before Guard", async () => {
    for (const req of [
      Object.defineProperty(requirements(), "amount", {
        enumerable: true,
        get() {
          throw new Error("HOSTILE-SECRET getter");
        },
      }),
      Object.defineProperty(requirements(), "payTo", {
        enumerable: false,
        value: SELLER,
      }),
    ]) {
      const { guard } = await open();
      const authorize = vi.spyOn(guard, "authorize");
      const hooks = x402GuardHooks(guard);
      await expect(hooks.onBeforePaymentCreation({
        paymentRequired: paymentRequired(req),
        selectedRequirements: req,
      } as never)).resolves.toEqual({
        abort: true,
        reason: "x402-guard: malformed payment challenge",
      });
      expect(authorize).not.toHaveBeenCalled();
      expect(guard.history()).toHaveLength(0);
    }
  });
});

describe("canonical EIP-3009 authorization parsing", () => {
  it("preserves a canonical validBefore beyond Number precision as bigint seconds", async () => {
    const huge = "900719925474099312345678901234567890";
    const { guard } = await open();
    const hooks = x402GuardHooks(guard);
    await authorizeAndAttach(
      hooks,
      requirements("1000000"),
      { nonce: NONCE, validBefore: huge, from: PAYER, value: "1000000" },
    );

    const attached = guard.history().find(
      (entry) => entry.status === "authorization_attached",
    );
    expect(attached).toBeDefined();
    expect(attached && "validBefore" in attached ? attached.validBefore : undefined).toBe(
      BigInt(huge),
    );
  });

  for (const [name, invalid] of [
    ["exponent", "1e9"],
    ["fraction", "1780000000.5"],
    ["negative", "-1"],
    ["leading plus", "+1"],
    ["leading zero", "01780000000"],
    ["leading whitespace", " 1780000000"],
    ["trailing whitespace", "1780000000 "],
    ["empty string", ""],
    ["NaN string", "NaN"],
    ["Infinity string", "Infinity"],
    ["null", null],
    ["number", 1_780_000_000],
    ["number NaN", Number.NaN],
    ["number Infinity", Number.POSITIVE_INFINITY],
    ["79-digit integer", "1".repeat(79)],
    ["uint256 overflow", UINT256_OVERFLOW],
  ] as const) {
    it(`keeps the hold committed for an invalid ${name} deadline`, async () => {
      const { guard } = await open();
      const hooks = x402GuardHooks(guard);
      await expect(
        authorizeAndAttach(hooks, requirements("1000000"), {
          nonce: NONCE,
          validBefore: invalid,
          from: PAYER,
          value: "1000000",
        }),
      ).rejects.toBeInstanceOf(X402GuardLifecycleError);

      const latest = guard.history().at(-1);
      expect(latest).toMatchObject({
        status: "indeterminate",
        reason: "authorization_unreadable",
      });
      expect(guard.history().some((entry) => entry.status === "released")).toBe(false);
    });
  }

  it("rejects a missing deadline, malformed payer, and malformed nonce without release", async () => {
    for (const mutation of ["missing-deadline", "payer", "nonce"] as const) {
      const { guard } = await open();
      const hooks = x402GuardHooks(guard);
      const req = requirements("1000000");
      const required = paymentRequired(req);
      const payload = paymentPayload(req, required, { value: "1000000" });
      const authorization = payload.payload.authorization as Record<string, unknown>;
      if (mutation === "missing-deadline") delete authorization.validBefore;
      if (mutation === "payer") authorization.from = "not-an-address";
      if (mutation === "nonce") authorization.nonce = "not-a-nonce";

      await hooks.onBeforePaymentCreation({
        paymentRequired: required,
        selectedRequirements: req,
      });
      await expect(hooks.onAfterPaymentCreation({
          paymentRequired: required,
          selectedRequirements: req,
          paymentPayload: payload,
        })).rejects.toBeInstanceOf(X402GuardLifecycleError);

      expect(guard.history().at(-1)).toMatchObject({
        status: "indeterminate",
        reason: "authorization_unreadable",
      });
      expect(guard.history().some((entry) => entry.status === "released")).toBe(false);
    }
  });

  it("keeps mismatched recipient, value, and validAfter authorizations indeterminate", async () => {
    const overrides = [
      { value: "1800001" },
      { to: "0x0000000000000000000000000000000000000001" },
      { validAfter: "1" },
    ];
    for (const override of overrides) {
      const { guard } = await open();
      const hooks = x402GuardHooks(guard);
      await expect(
        authorizeAndAttach(hooks, requirements(), override),
      ).rejects.toBeInstanceOf(X402GuardLifecycleError);
      expect(guard.history().at(-1)).toMatchObject({
        status: "indeterminate",
        reason: "authorization_unreadable",
      });
      expect(guard.history().some((entry) => entry.status === "released")).toBe(false);
    }
  });

  it("latches a huge redirected signer payload and blocks authority across reopen", async () => {
    const { guard, store, chain } = await open();
    const hooks = x402GuardHooks(guard);
    const req = requirements();
    const required = paymentRequired(req);
    await hooks.onBeforePaymentCreation({
      paymentRequired: required,
      selectedRequirements: req,
    });
    await expect(hooks.onAfterPaymentCreation({
        paymentRequired: required,
        selectedRequirements: req,
        paymentPayload: paymentPayload(req, required, {
          nonce: NONCE,
          from: PAYER,
          value: (1n << 255n).toString(),
          to: "0x0000000000000000000000000000000000000001",
        }),
      })).rejects.toBeInstanceOf(X402GuardLifecycleError);

    const holdId = guard.history()[0]!.holdId;
    expect(guard.history().at(-1)).toMatchObject({
      status: "indeterminate",
      reason: "authorization_unreadable",
    });
    await expect(guard.authorize({
      amount: 1n,
      asset: USDC,
      network: NET,
      payTo: SELLER,
      resource: "https://api.example/next",
    })).rejects.toBeInstanceOf(AuthorityExposureError);
    await expect(
      guard.attachAuthorization(
        holdId,
        `0x${"34".repeat(32)}`,
        PAYER,
        BigInt(Math.floor(NOW / 1000) + 3_600),
      ),
    ).rejects.toThrow(/indeterminate, cannot attach authorization/);
    expect((guard as unknown as Record<string, unknown>)["abandonUnsigned"]).toBeUndefined();
    expect(guard.history()).toHaveLength(2);

    const reopened = await Guard.open({
      loadedPolicy: loadPolicy(POLICY_DOCUMENT, NOW),
      store,
      chain: chain.reader,
      clock,
    });
    expect(reopened.history()).toHaveLength(2);
    await expect(reopened.authorize({
      amount: 1n,
      asset: USDC,
      network: NET,
      payTo: SELLER,
      resource: "https://api.example/after-reopen",
    })).rejects.toBeInstanceOf(AuthorityExposureError);
    await expect(reopened.reconcileHold(holdId)).resolves.toEqual({
      holdId,
      outcome: "indeterminate",
      reason: "authorization_unreadable",
    });
  });

  it("matches the signed payload against the immutable pre-sign quote snapshot", async () => {
    const { guard } = await open();
    const hooks = x402GuardHooks(guard);
    const req = requirements();
    const required = paymentRequired(req);
    await hooks.onBeforePaymentCreation({
      paymentRequired: required,
      selectedRequirements: req,
    });

    // A caller retaining the object cannot redirect the expected authorization
    // between the before and after hooks.
    expect(() => {
      req.amount = "1";
    }).toThrow(TypeError);
    expect(() => {
      req.payTo = "0x0000000000000000000000000000000000000001";
    }).toThrow(TypeError);
    await hooks.onAfterPaymentCreation({
      paymentRequired: required,
      selectedRequirements: req,
      paymentPayload: paymentPayload(req, required),
    });

    expect(guard.history().at(-1)).toMatchObject({
      status: "authorization_attached",
      amount: 1_800_000n,
      quote: { payTo: SELLER.toLowerCase() },
    });
  });

  it("freezes the exact signed payload before any later after-hook can mutate it", async () => {
    const { guard } = await open();
    const hooks = x402GuardHooks(guard);
    const req = requirements();
    const required = paymentRequired(req, {});
    const payload = paymentPayload(req, required);
    const context = {
      paymentRequired: required,
      selectedRequirements: req,
      paymentPayload: payload,
    };

    await hooks.onBeforePaymentCreation({ paymentRequired: required, selectedRequirements: req });
    await hooks.onAfterPaymentCreation(context);

    for (const value of [
      context,
      payload,
      payload.resource,
      payload.extensions,
      payload.payload,
      payload.payload.authorization,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }

    const laterAfterHook = async () => {
      payload.payload.authorization.to =
        "0x0000000000000000000000000000000000000001";
    };
    await expect(laterAfterHook()).rejects.toBeInstanceOf(TypeError);

    const recoveryHook = vi.fn(async () => ({
      recovered: true as const,
      payload: {} as never,
    }));
    const runFailureHooksInCoreOrder = async () => {
      await hooks.onPaymentCreationFailure({
        paymentRequired: required,
        selectedRequirements: req,
        error: new Error("later after hook failed"),
      });
      await recoveryHook();
    };
    await expect(runFailureHooksInCoreOrder()).rejects.toEqual(
      new X402GuardLifecycleError(),
    );
    expect(recoveryHook).not.toHaveBeenCalled();
  });

  it("quarantines noncanonical outer, inner, and authorization payload shapes", async () => {
    const mutations: Array<(payload: ReturnType<typeof paymentPayload>) => void> = [
      (payload) => {
        payload.accepted = { ...payload.accepted };
      },
      (payload) => {
        (payload as unknown as Record<string, unknown>)["futureRail"] = true;
      },
      (payload) => {
        (payload.payload as unknown as Record<string, unknown>)["futureSigner"] = true;
      },
      (payload) => {
        (payload.payload.authorization as unknown as Record<string, unknown>)[
          "redirect"
        ] = SELLER;
      },
      (payload) => {
        payload.extensions = { recover: "HOSTILE-SECRET" };
      },
      (payload) => {
        Object.defineProperty(payload, "accepted", {
          enumerable: true,
          get() {
            throw new Error("HOSTILE-SECRET getter");
          },
        });
      },
      (payload) => {
        payload.payload.signature = "0x123";
      },
    ];

    for (const mutate of mutations) {
      const { guard } = await open();
      const hooks = x402GuardHooks(guard);
      const req = requirements();
      const required = paymentRequired(req);
      const payload = paymentPayload(req, required);
      mutate(payload);
      await hooks.onBeforePaymentCreation({
        paymentRequired: required,
        selectedRequirements: req,
      });
      await expect(hooks.onAfterPaymentCreation({
        paymentRequired: required,
        selectedRequirements: req,
        paymentPayload: payload,
      })).rejects.toBeInstanceOf(X402GuardLifecycleError);
      expect(guard.history().at(-1)).toMatchObject({
        status: "indeterminate",
        reason: "authorization_unreadable",
      });
    }
  });
});

describe("ambiguous failures remain committed and redact upstream text", () => {
  it("never treats the generic creation-failure hook as proof nothing was signed", async () => {
    const secret = "signer rejected at https://wallet.invalid/API_KEY_SUPER_SECRET";
    const { guard } = await open();
    const hooks = x402GuardHooks(guard);
    const req = requirements();
    const required = paymentRequired(req);

    await hooks.onBeforePaymentCreation({
      paymentRequired: required,
      selectedRequirements: req,
    });
    await expect(hooks.onPaymentCreationFailure({
        paymentRequired: required,
        selectedRequirements: req,
        error: new Error(secret),
      })).rejects.toBeInstanceOf(X402GuardLifecycleError);

    expect(guard.history().at(-1)).toMatchObject({
      status: "indeterminate",
      reason: "creation_outcome_unknown",
    });
    expect(guard.history().some((entry) => entry.status === "released")).toBe(false);
    expect((guard as unknown as Record<string, unknown>)["abandonUnsigned"]).toBeUndefined();
    expect(jsonSafe(guard.history())).not.toContain("SUPER_SECRET");

    // The failed attempt still consumes $1.80 of the $5 budget.
    const secondReq = requirements();
    const secondRequired = paymentRequired(secondReq);
    expect((await hooks.onBeforePaymentCreation({
      paymentRequired: secondRequired,
      selectedRequirements: secondReq,
    }))).toBeUndefined();
    await expect(hooks.onPaymentCreationFailure({
        paymentRequired: secondRequired,
        selectedRequirements: secondReq,
        error: new Error("second exact-signer outcome unknown"),
      })).rejects.toBeInstanceOf(X402GuardLifecycleError);
    const thirdReq = requirements();
    expect(await hooks.onBeforePaymentCreation({
      paymentRequired: paymentRequired(thirdReq),
      selectedRequirements: thirdReq,
    })).toEqual({
      abort: true,
      reason: "x402-guard: policy budget_exceeded",
    });
  });

  it("lets only the first after-creation or failure hook claim a pending hold", async () => {
    const first = await open();
    const firstHooks = x402GuardHooks(first.guard);
    const firstReq = requirements();
    const firstRequired = paymentRequired(firstReq);
    await firstHooks.onBeforePaymentCreation({
      paymentRequired: firstRequired,
      selectedRequirements: firstReq,
    });
    await expect(firstHooks.onPaymentCreationFailure({
        paymentRequired: firstRequired,
        selectedRequirements: firstReq,
        error: new Error("first callback wins"),
      })).rejects.toBeInstanceOf(X402GuardLifecycleError);
    await firstHooks.onAfterPaymentCreation({
      paymentRequired: firstRequired,
      selectedRequirements: firstReq,
      paymentPayload: paymentPayload(firstReq, firstRequired),
    });
    expect(first.guard.history().map((entry) => entry.status)).toEqual([
      "held",
      "indeterminate",
    ]);
    expect(first.guard.history().at(-1)).toMatchObject({
      reason: "creation_outcome_unknown",
    });

    const second = await open();
    const secondHooks = x402GuardHooks(second.guard);
    const secondReq = requirements();
    const secondRequired = paymentRequired(secondReq);
    const malformed = paymentPayload(secondReq, secondRequired);
    delete (malformed.payload.authorization as Record<string, unknown>).validBefore;
    await secondHooks.onBeforePaymentCreation({
      paymentRequired: secondRequired,
      selectedRequirements: secondReq,
    });
    await expect(secondHooks.onAfterPaymentCreation({
        paymentRequired: secondRequired,
        selectedRequirements: secondReq,
        paymentPayload: malformed,
      })).rejects.toBeInstanceOf(X402GuardLifecycleError);
    await expect(secondHooks.onPaymentCreationFailure({
        paymentRequired: secondRequired,
        selectedRequirements: secondReq,
        error: new Error("duplicate callback must be ignored"),
      })).rejects.toBeInstanceOf(X402GuardLifecycleError);
    expect(second.guard.history().map((entry) => entry.status)).toEqual([
      "held",
      "indeterminate",
    ]);
    expect(second.guard.history().at(-1)).toMatchObject({
      reason: "authorization_unreadable",
    });
  });
});

describe("facilitator responses are hints, not settlement authority", () => {
  it("keeps a facilitator success nonterminal when chain proof is unknown", async () => {
    const { guard, chain } = await open({
      state: "unknown",
      reason: "settlement_mismatch",
    });
    const hooks = x402GuardHooks(guard);
    const { req, payload } = await authorizeAndAttach(hooks);

    await hooks.onPaymentResponse({
      paymentPayload: payload,
      requirements: req,
      settleResponse: { success: true, transaction: HINT_TX, payer: PAYER },
    });

    expect(chain.findPayment).toHaveBeenCalledOnce();
    expect(guard.history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "settlement_reported",
          transactionHint: HINT_TX,
        }),
        expect.objectContaining({
          status: "indeterminate",
          reason: "settlement_mismatch",
        }),
      ]),
    );
    expect(guard.history().some((entry) => entry.status === "settled")).toBe(false);
  });

  it("settles only from the exact chain-reader result, not the facilitator hint", async () => {
    const { guard, chain } = await open((params) => {
      expect(params).toMatchObject({
        nonce: NONCE,
        payer: PAYER,
        validBefore: BigInt(Math.floor(NOW / 1000) + 3_600),
      });
      expect(params.quote).toMatchObject({
        amount: 1_800_000n,
        network: NET,
      });
      expect(params.quote.asset).toBe(USDC.toLowerCase());
      expect(params.quote.payTo).toBe(SELLER.toLowerCase());
      return {
        state: "settled",
        transaction: CHAIN_TX,
        settlementAt: NOW + 120_000,
        finalizedBlock: FINALIZED,
      };
    });
    const hooks = x402GuardHooks(guard);
    const { req, payload } = await authorizeAndAttach(hooks);

    await hooks.onPaymentResponse({
      paymentPayload: payload,
      requirements: req,
      settleResponse: { success: true, transaction: HINT_TX, payer: PAYER },
    });

    expect(chain.findPayment).toHaveBeenCalledOnce();
    expect(guard.history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "settlement_reported",
          transactionHint: HINT_TX,
        }),
        expect.objectContaining({
          status: "settled",
          transaction: CHAIN_TX,
        }),
      ]),
    );
  });

  it("routes malformed success transaction text to reconciliation without persisting it", async () => {
    const hostile = "https://facilitator.invalid/SECRET_TRANSACTION_HINT";
    const { guard, chain } = await open({
      state: "unknown",
      reason: "settlement_receipt_unavailable",
    });
    const hooks = x402GuardHooks(guard);
    const { req, payload } = await authorizeAndAttach(hooks);

    await hooks.onPaymentResponse({
      paymentPayload: payload,
      requirements: req,
      settleResponse: { success: true, transaction: hostile, payer: PAYER },
    });

    expect(chain.findPayment).toHaveBeenCalledOnce();
    expect(guard.history().some((entry) => entry.status === "settlement_reported")).toBe(false);
    expect(guard.history().at(-1)).toMatchObject({
      status: "indeterminate",
      reason: "settlement_receipt_unavailable",
    });
    expect(jsonSafe(guard.history())).not.toContain("SECRET_TRANSACTION_HINT");
  });
});

describe("hostile challenges fail closed with bounded reasons", () => {
  for (const [name, mutate, expected] of [
    [
      "scheme",
      (req: ReturnType<typeof requirements>) => ({
        ...req,
        scheme: "hostile-secret-scheme",
      }),
      "x402-guard: unsupported settlement scheme",
    ],
    [
      "network",
      (req: ReturnType<typeof requirements>) => ({
        ...req,
        network: "eip155:1-hostile-secret",
      }),
      "x402-guard: unsupported settlement rail",
    ],
    [
      "asset",
      (req: ReturnType<typeof requirements>) => ({
        ...req,
        asset: "0x0000000000000000000000000000000000000001",
      }),
      "x402-guard: unsupported settlement rail",
    ],
    [
      "Permit2 transfer method",
      (req: ReturnType<typeof requirements>) => ({
        ...req,
        extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" },
      }),
      "x402-guard: unsupported settlement rail",
    ],
    [
      "future extra switch",
      (req: ReturnType<typeof requirements>) => ({
        ...req,
        extra: { name: "USDC", version: "2", futureSigner: "HOSTILE-SECRET" },
      }),
      "x402-guard: malformed payment challenge",
    ],
    [
      "wrong EIP-712 domain",
      (req: ReturnType<typeof requirements>) => ({
        ...req,
        extra: { name: "HostileToken", version: "999" },
      }),
      "x402-guard: unsupported settlement rail",
    ],
    [
      "zero timeout",
      (req: ReturnType<typeof requirements>) => ({ ...req, maxTimeoutSeconds: 0 }),
      "x402-guard: malformed payment challenge",
    ],
    [
      "fractional timeout",
      (req: ReturnType<typeof requirements>) => ({ ...req, maxTimeoutSeconds: 1.5 }),
      "x402-guard: malformed payment challenge",
    ],
    [
      "oversized timeout",
      (req: ReturnType<typeof requirements>) => ({ ...req, maxTimeoutSeconds: 3_601 }),
      "x402-guard: malformed payment challenge",
    ],
    [
      "missing timeout",
      (req: ReturnType<typeof requirements>) => ({
        ...req,
        maxTimeoutSeconds: undefined,
      }),
      "x402-guard: malformed payment challenge",
    ],
    [
      "amount",
      (req: ReturnType<typeof requirements>) => ({
        ...req,
        amount: "1e9-HOSTILE-SECRET",
      }),
      "x402-guard: malformed payment challenge",
    ],
    [
      "79-digit amount",
      (req: ReturnType<typeof requirements>) => ({
        ...req,
        amount: "1".repeat(79),
      }),
      "x402-guard: malformed payment challenge",
    ],
    [
      "uint256-overflow amount",
      (req: ReturnType<typeof requirements>) => ({
        ...req,
        amount: UINT256_OVERFLOW,
      }),
      "x402-guard: malformed payment challenge",
    ],
  ] as const) {
    it(`rejects a hostile ${name} without echoing it or creating a hold`, async () => {
      const { guard } = await open();
      const authorize = vi.spyOn(guard, "authorize");
      const hooks = x402GuardHooks(guard);
      const req = mutate(requirements());
      const result = await hooks.onBeforePaymentCreation({
        paymentRequired: paymentRequired(req),
        selectedRequirements: req,
      });
      expect(result).toEqual({ abort: true, reason: expected });
      expect(result?.reason).not.toContain("HOSTILE");
      expect(authorize).not.toHaveBeenCalled();
      expect(guard.history()).toHaveLength(0);
    });
  }

  it("accepts only the explicitly pinned EIP-3009 transfer selector", async () => {
    const { guard } = await open();
    const hooks = x402GuardHooks(guard);
    const req = {
      ...requirements(),
      extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
    };
    await expect(hooks.onBeforePaymentCreation({
      paymentRequired: paymentRequired(req),
      selectedRequirements: req,
    })).resolves.toBeUndefined();
    expect(guard.history()).toHaveLength(1);
    expect(guard.history()[0]!.status).toBe("held");
  });

  it("rejects accessor and throwing-proxy extra metadata without invoking Guard", async () => {
    for (const extra of [
      Object.defineProperty({}, "name", {
        enumerable: true,
        get() {
          throw new Error("HOSTILE-SECRET getter");
        },
      }),
      new Proxy({}, {
        getPrototypeOf() {
          throw new Error("HOSTILE-SECRET proxy");
        },
      }),
    ]) {
      const { guard } = await open();
      const authorize = vi.spyOn(guard, "authorize");
      const hooks = x402GuardHooks(guard);
      const req = { ...requirements(), extra };
      await expect(hooks.onBeforePaymentCreation({
        paymentRequired: paymentRequired(req),
        selectedRequirements: req,
      })).resolves.toEqual({
        abort: true,
        reason: "x402-guard: malformed payment challenge",
      });
      expect(authorize).not.toHaveBeenCalled();
      expect(guard.history()).toHaveLength(0);
    }
  });

  it("bounds the resource by UTF-8 bytes before hashing or creating a hold", async () => {
    const { guard } = await open();
    const authorize = vi.spyOn(guard, "authorize");
    const hooks = x402GuardHooks(guard);
    const oversized = `https://example.invalid/${"🔥".repeat(2_100)}`;
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(8_192);
    const req = requirements();

    const result = await hooks.onBeforePaymentCreation({
      paymentRequired: {
        ...paymentRequired(req),
        resource: { url: oversized },
      },
      selectedRequirements: req,
    });

    expect(result).toEqual({
      abort: true,
      reason: "x402-guard: malformed payment challenge",
    });
    expect(result?.reason).not.toContain("example.invalid");
    expect(authorize).not.toHaveBeenCalled();
    expect(guard.history()).toHaveLength(0);
  });

  it("persists only a resource fingerprint, never URL credentials or query tokens", async () => {
    const secretUrl =
      "https://user:password@example.invalid/report?api_key=SUPER_SECRET_TOKEN";
    const { guard, store } = await open();
    const hooks = x402GuardHooks(guard);
    const req = requirements("1000000");
    const result = await hooks.onBeforePaymentCreation({
      paymentRequired: {
        ...paymentRequired(req),
        resource: { url: secretUrl },
      },
      selectedRequirements: req,
    });

    expect(result).toBeUndefined();
    expect(guard.history().at(-1)).toMatchObject({
      quote: { resourceHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
    });
    expect(jsonSafe(guard.history())).not.toContain("SUPER_SECRET_TOKEN");
    expect(jsonSafe(store.written)).not.toContain("password");
    expect(jsonSafe(store.written)).not.toContain("example.invalid");
  });

  it("treats malformed runtime hook objects as unreadable without throwing", async () => {
    const { guard } = await open();
    const hooks = x402GuardHooks(guard);
    await expect(
      hooks.onBeforePaymentCreation({
        paymentRequired: null,
        selectedRequirements: null,
      } as never),
    ).resolves.toEqual({
      abort: true,
      reason: "x402-guard: malformed payment challenge",
    });

    const { req } = await authorizeAndAttach(hooks);
    await expect(
      hooks.onPaymentResponse({
        paymentPayload: null,
        requirements: req,
      } as never),
    ).resolves.toBeUndefined();
  });
});

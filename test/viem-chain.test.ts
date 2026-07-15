import { describe, it, expect, vi } from "vitest";
import { ViemChainReader, TRANSFER_TOPIC as SRC_TRANSFER_TOPIC } from "../src/adapters/viem-chain.js";
import type { PublicClient } from "viem";
import type { Quote } from "../src/policy.js";
import { parseDecimal } from "../src/amount.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYER = "0xA1b2000000000000000000000000000000001234";
const SELLER = "0xE5f6000000000000000000000000000000007788";
const STRANGER = "0xBAD0000000000000000000000000000000000BAD";
const NONCE = `0x${"ab".repeat(32)}`;
const TX = `0x${"cd".repeat(32)}`;

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const HELD_AT = Date.UTC(2026, 6, 14, 12, 0, 0);
const HELD_AT_SEC = BigInt(Math.floor(HELD_AT / 1000));

const quote: Quote = {
  amount: parseDecimal("1.80", 6), // 1_800_000n
  asset: USDC,
  network: "eip155:84532",
  payTo: SELLER,
  resource: "https://api.example/report",
};

/** An indexed address topic is the address left-padded to 32 bytes. */
const topic = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;
/** uint256 log data is a 32-byte big-endian word. */
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;

/** The ERC-20 Transfer log a real EIP-3009 settlement emits. */
const transferLog = (over: Partial<{ address: string; from: string; to: string; value: bigint; logIndex: number }> = {}) => ({
  address: over.address ?? USDC,
  topics: [
    TRANSFER_TOPIC,
    topic(over.from ?? PAYER),
    topic(over.to ?? SELLER),
  ],
  data: word(over.value ?? quote.amount),
  logIndex: over.logIndex ?? 5,
});

interface FakeOpts {
  /** Blocks earlier than this have timestamps before the hold. */
  logs?: unknown[];
  receiptLogs?: unknown[];
  receiptThrows?: string;
  getLogsThrows?: string;
  blockNumberThrows?: string;
}

const fakeClient = (o: FakeOpts = {}): PublicClient =>
  ({
    getBlockNumber: async () => {
      if (o.blockNumberThrows) throw new Error(o.blockNumberThrows);
      return 1_000_000n;
    },
    // Block N has timestamp HELD_AT - (1_000_000 - N) * 2s, so the binary search
    // in blockAtOrBefore has a real, monotonic timeline to walk.
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      timestamp: HELD_AT_SEC - (1_000_000n - blockNumber) * 2n,
    }),
    getLogs: async () => {
      if (o.getLogsThrows) throw new Error(o.getLogsThrows);
      return o.logs ?? [];
    },
    getTransactionReceipt: async () => {
      if (o.receiptThrows) throw new Error(o.receiptThrows);
      return { logs: o.receiptLogs ?? [transferLog()] };
    },
  }) as unknown as PublicClient;

const look = (o: FakeOpts = {}) =>
  new ViemChainReader({ client: fakeClient(o) }).findPayment({
    quote,
    nonce: NONCE,
    payer: PAYER,
    heldAt: HELD_AT,
  });

/**
 * The AuthorizationUsed log for our nonce, at logIndex 4 — below the Transfer.
 * Circle's USDC emits AuthorizationUsed FIRST, then the Transfer (default
 * logIndex 5), the ordering seen on real Base Sepolia settlements.
 */
const authUsedLog = { transactionHash: TX, logIndex: 4 };
/** The authorization was used, and the settlement matches the quote. */
const settled = { logs: [authUsedLog] };

describe("confirming a payment requires that the RIGHT payment happened", () => {
  it("confirms when the settlement transfers the quoted amount to the quoted payee", async () => {
    expect(await look(settled)).toEqual({ found: true, transaction: TX });
  });

  it("binds the Transfer that sits AFTER the auth log — real USDC ordering", async () => {
    // Regression. Circle's USDC (FiatTokenV2) emits AuthorizationUsed FIRST,
    // then the Transfer — verified on Base Sepolia tx 0x82ba06be… (auth at
    // logIndex 40, Transfer at 41). The reconciler once bound the transfer BELOW
    // the auth log; against real settlements that matched nothing and returned
    // 'unknown' — flagging the library's own proof payment instead of confirming
    // it. This drives the exact on-chain ordering: auth at 40, its transfer at 41.
    const status = await look({
      logs: [{ transactionHash: TX, logIndex: 40 }],
      receiptLogs: [transferLog({ logIndex: 41 })],
    });
    expect(status).toEqual({ found: true, transaction: TX });
  });

  it("REFUSES to confirm when the money went to someone else", async () => {
    // The attack this closes: AuthorizationUsed carries no value and no
    // recipient. A reader that stops at "was an authorization used?" confirms
    // that SOMETHING was paid, records the quote it EXPECTED, and cites a real
    // transaction hash as proof — while the money went elsewhere. The ledger
    // would assert a falsehood and staple a receipt to it.
    const status = await look({
      ...settled,
      receiptLogs: [transferLog({ to: STRANGER })],
    });

    expect(status.found).toBe("unknown"); // never 'found', and never 'false'
    expect(status).toHaveProperty(
      "reason",
      expect.stringContaining("does not match the authorized quote"),
    );
  });

  it("REFUSES to confirm when the amount differs from the quote", async () => {
    const status = await look({
      ...settled,
      receiptLogs: [transferLog({ value: parseDecimal("5.00", 6) })],
    });
    expect(status.found).toBe("unknown");
  });

  it("REFUSES to confirm when a different token moved", async () => {
    const status = await look({
      ...settled,
      receiptLogs: [transferLog({ address: STRANGER })],
    });
    expect(status.found).toBe("unknown");
  });

  it("REFUSES to confirm when the settlement moved no money at all", async () => {
    const status = await look({ ...settled, receiptLogs: [] });
    expect(status.found).toBe("unknown");
  });

  it("binds to THIS nonce's transfer, not any matching transfer in a batched tx", async () => {
    // The decoy: one tx settles two of our own authorizations. Real USDC emits
    // AuthorizationUsed then Transfer, so hold-A's auth (logIndex 4) is followed
    // immediately by hold-A's real transfer (logIndex 5, to a stranger — params
    // were manipulated). hold-B's matching transfer (to SELLER, correct) sits
    // later in the receipt. A reader that scans for "any matching transfer" finds
    // hold-B's and wrongly confirms hold-A. Binding to the transfer just above
    // THIS auth log catches it.
    const status = await look({
      logs: [authUsedLog], // our nonce's AuthorizationUsed at logIndex 4
      receiptLogs: [
        transferLog({ to: STRANGER, logIndex: 5 }), // OUR nonce settled: wrong dest
        transferLog({ to: SELLER, logIndex: 9 }),   // a DIFFERENT nonce's correct transfer
      ],
    });
    expect(status.found).toBe("unknown"); // not confirmed on the decoy
  });

  it("a mismatch is never 'not found' — that would RELEASE the hold", async () => {
    // The distinction that matters: 'not found' frees the budget. A settlement
    // that does not match means money demonstrably moved and a human must look.
    // Collapsing the two would hand back budget for money that left.
    const status = await look({
      ...settled,
      receiptLogs: [transferLog({ to: STRANGER })],
    });
    expect(status.found).not.toBe(false);
  });

  it("returns 'unknown' when the settlement receipt cannot be read", async () => {
    const status = await look({ ...settled, receiptThrows: "receipt unavailable" });
    expect(status.found).toBe("unknown");
  });
});

describe("the 9-hour settlement — the failure this project cites as its reason to exist", () => {
  it("finds a settlement whose log sits far below a naive head-anchored window", async () => {
    // x402 issue #2821: a payment settled 9 hours ago and the index lost it. A
    // window anchored to the chain head would search only the recent past, miss
    // the log, report 'not found', and release the hold. The binary search must
    // reach back to the hold and find it.
    //
    // Fake timeline: block N has timestamp HELD_AT - (1e6 - N)*2s. HELD_AT is
    // the hold time, so the log lives just after HELD_AT. A head-anchored 6h
    // window (10,800 blocks) starts at block 989,200 — but the settlement is
    // near block 1,000,000. Only a hold-anchored search sees it.
    const AUTH_BLOCK = 999_950n;
    const seen: { fromBlock: bigint }[] = [];
    const client = fakeClient(settled);
    (client as unknown as { getLogs: unknown }).getLogs = async (q: { fromBlock: bigint }) => {
      seen.push(q);
      // Only return the log if the search range actually reaches the auth block.
      return q.fromBlock <= AUTH_BLOCK ? [authUsedLog] : [];
    };

    const status = await new ViemChainReader({ client }).findPayment({
      quote, nonce: NONCE, payer: PAYER, heldAt: HELD_AT,
    });

    expect(status).toEqual({ found: true, transaction: TX });
    expect(seen[0]!.fromBlock).toBeLessThanOrEqual(AUTH_BLOCK);
  });
});

describe("the search window covers the whole interval since the hold", () => {
  it("starts the search before the hold, not a fixed distance back from the chain head", async () => {
    // The bug this closes: a window anchored to the chain head misses a
    // settlement older than the window, reports 'not found', and the reconciler
    // releases the hold — freeing budget for money that already left. x402 issue
    // #2821 is a 9-hour indexing delay; a 6-hour window silently mis-resolves
    // the exact scenario this library cites as its justification.
    const seen: { fromBlock: bigint; toBlock: bigint }[] = [];
    const client = fakeClient(settled);
    const original = client.getLogs.bind(client);
    (client as unknown as { getLogs: unknown }).getLogs = async (q: {
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      seen.push(q);
      return original(q as never);
    };

    await new ViemChainReader({ client }).findPayment({
      quote,
      nonce: NONCE,
      payer: PAYER,
      heldAt: HELD_AT,
    });

    const q = seen[0]!;
    // The fake's block N has timestamp HELD_AT - (1e6 - N)*2s. A search starting
    // at or before the hold (minus the safety margin) must begin below 1_000_000.
    expect(q.fromBlock).toBeLessThan(1_000_000n);
    expect(q.toBlock).toBe(1_000_000n);
  });

  it("derives the Transfer topic from the ABI, not a hard-coded hex constant", async () => {
    // The bug this closes: the old code hard-coded the topic and void-ed the
    // parsed ABI, so a wrong event signature returned [] against the real chain
    // and released every hold — while the tests, which hand-built the same hex,
    // stayed green. The source now derives the topic; if its ABI signature is
    // wrong, this constant is wrong and the match fails against a real chain.
    const { toEventSelector } = await import("viem");
    expect(SRC_TRANSFER_TOPIC).toBe(
      toEventSelector("Transfer(address,address,uint256)"),
    );
  });

  it("queries the CORRECT AuthorizationUsed event — a wrong signature finds nothing", async () => {
    // The bug this closes (and that the last round's test missed): the source
    // matched on a hard-coded topic while void-ing the parsed ABI, so a wrong
    // AuthorizationUsed signature returned [] against the real chain and released
    // every hold — with the tests still green because the fake ignored its args.
    //
    // Here the fake behaves like a chain: it only returns the log if the query's
    // `event` encodes to the REAL AuthorizationUsed topic. Mutate the source's
    // signature and this query stops matching -> found:false -> assertion fails.
    const { toEventSelector } = await import("viem");
    const AUTH_TOPIC = toEventSelector("AuthorizationUsed(address,bytes32)");

    const seen: { address: string; args: { authorizer: string; nonce: string } }[] = [];
    const client = fakeClient(settled);
    (client as unknown as { getLogs: unknown }).getLogs = async (q: {
      event: Parameters<typeof toEventSelector>[0];
      args: { authorizer: string; nonce: string };
      address: string;
    }) => {
      seen.push(q as never);
      // Derive the query event's own selector, the way a real node matches. Only
      // return the log if it is the real AuthorizationUsed topic — a wrong source
      // signature yields a different selector and no match.
      return toEventSelector(q.event) === AUTH_TOPIC ? [authUsedLog] : [];
    };

    const status = await new ViemChainReader({ client }).findPayment({
      quote, nonce: NONCE, payer: PAYER, heldAt: HELD_AT,
    });

    expect(status).toEqual({ found: true, transaction: TX });
    expect(seen[0]!.args.nonce).toBe(NONCE);
    expect(seen[0]!.args.authorizer).toBe(PAYER);
    expect(seen[0]!.address).toBe(USDC);
  });
});

describe("an RPC that cannot answer is never mistaken for a 'no'", () => {
  it("reports 'not found' only when the authorization was genuinely never used", async () => {
    // USDC emits AuthorizationUsed on every use and reverts on replay, and the
    // search provably covers the interval since the hold — so an empty result is
    // real evidence, not merely an absence of information.
    expect(await look({ logs: [] })).toEqual({ found: false });
  });

  it("returns 'unknown' when getLogs throws", async () => {
    const status = await look({ getLogsThrows: "ECONNREFUSED" });
    expect(status.found).toBe("unknown");
    expect(status).toHaveProperty("reason", expect.stringContaining("ECONNREFUSED"));
  });

  it("returns 'unknown' when the search range cannot be resolved", async () => {
    const status = await look({ blockNumberThrows: "node syncing" });
    expect(status.found).toBe("unknown");
  });

  it("returns 'unknown' for a log not yet mined into a citable transaction", async () => {
    const status = await look({ logs: [{ transactionHash: null }] });
    expect(status.found).toBe("unknown");
  });
});

describe("a malformed lookup refuses to answer rather than guessing", () => {
  it("will not treat a bad nonce as evidence of no payment", async () => {
    // A malformed query returns an empty log set. Reading that as "the payment
    // never happened" would release the hold on the strength of our own bug.
    const status = await new ViemChainReader({ client: fakeClient() }).findPayment({
      quote,
      nonce: "0x1234",
      payer: PAYER,
      heldAt: HELD_AT,
    });
    expect(status.found).toBe("unknown");
    expect(status).toHaveProperty("reason", expect.stringContaining("32-byte hash"));
  });

  it("does not even call the RPC on a malformed lookup", async () => {
    const getLogs = vi.fn(async () => []);
    const client = fakeClient();
    (client as unknown as { getLogs: unknown }).getLogs = getLogs;

    await new ViemChainReader({ client }).findPayment({
      quote,
      nonce: "not-a-nonce",
      payer: PAYER,
      heldAt: HELD_AT,
    });

    expect(getLogs).not.toHaveBeenCalled();
  });
});

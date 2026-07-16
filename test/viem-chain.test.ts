import { describe, expect, it, vi } from "vitest";
import { toEventSelector, type PublicClient } from "viem";
import {
  AUTHORIZATION_USED_TOPIC,
  TRANSFER_TOPIC,
  ViemChainReader,
} from "../src/adapters/viem-chain.js";
import { SETTLEMENT_PROFILE, type EvidenceQuote } from "../src/policy.js";

const PAYER = "0xA1b2000000000000000000000000000000001234";
const SELLER = "0xE5f6000000000000000000000000000000007788";
const STRANGER = "0xBAD0000000000000000000000000000000000BAD";
const NONCE = `0x${"ab".repeat(32)}`;
const TX = `0x${"cd".repeat(32)}`;
const FINAL_HASH = `0x${"ef".repeat(32)}`;
const SETTLEMENT_HASH = `0x${"12".repeat(32)}`;

const HELD_AT = Date.UTC(2026, 6, 14, 12, 0, 0);
const HELD_AT_SEC = BigInt(Math.floor(HELD_AT / 1000));
const VALID_BEFORE = HELD_AT_SEC + 3_600n;
const FINAL_NUMBER = 1_000_000n;
const FINAL_TIMESTAMP = VALID_BEFORE + 600n;
const SETTLEMENT_BLOCK = FINAL_NUMBER - 100n;
const SETTLEMENT_TIMESTAMP = HELD_AT_SEC + 120n;

const quote: EvidenceQuote = Object.freeze({
  amount: 1_800_000n,
  asset: SETTLEMENT_PROFILE.asset,
  network: SETTLEMENT_PROFILE.network,
  payTo: SELLER,
  resourceHash: `sha256:${"1".repeat(64)}`,
});

const topic = (address: string) =>
  `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
const word = (value: bigint) =>
  `0x${value.toString(16).padStart(64, "0")}`;

const transferLog = (
  over: Partial<{
    address: string;
    from: string;
    to: string;
    value: bigint;
    logIndex: number;
  }> = {},
) => ({
  address: over.address ?? SETTLEMENT_PROFILE.asset,
  topics: [
    TRANSFER_TOPIC,
    topic(over.from ?? PAYER),
    topic(over.to ?? SELLER),
  ],
  data: word(over.value ?? quote.amount),
  logIndex: over.logIndex ?? 5,
  blockNumber: SETTLEMENT_BLOCK,
  blockHash: SETTLEMENT_HASH,
  transactionHash: TX,
  removed: false,
});

const authUsedLog = {
  address: SETTLEMENT_PROFILE.asset,
  topics: [AUTHORIZATION_USED_TOPIC, topic(PAYER), NONCE],
  data: "0x",
  transactionHash: TX,
  blockHash: SETTLEMENT_HASH,
  blockNumber: SETTLEMENT_BLOCK,
  logIndex: 4,
  removed: false,
};

interface FakeOptions {
  chainId?: number;
  chainIdError?: string;
  finalizedError?: string;
  malformedFinalized?: boolean;
  bytecode?: string;
  bytecodeError?: string;
  authorizationUsed?: boolean;
  authorizationStateError?: string;
  logs?: unknown[];
  logsError?: string;
  receiptError?: string;
  receiptStatus?: "success" | "reverted";
  receiptBlock?: bigint;
  receiptBlockHash?: string;
  receiptTransactionHash?: string;
  receiptLogs?: unknown[];
  settlementBlockError?: string;
}

function fakeClient(options: FakeOptions = {}) {
  const getChainId = vi.fn(async () => {
    if (options.chainIdError) throw new Error(options.chainIdError);
    return options.chainId ?? SETTLEMENT_PROFILE.chainId;
  });
  const getBlock = vi.fn(
    async ({
      blockTag,
      blockNumber,
    }: {
      blockTag?: string;
      blockNumber?: bigint;
    }) => {
      if (blockTag === "finalized") {
        if (options.finalizedError) throw new Error(options.finalizedError);
        if (options.malformedFinalized) {
          return { number: null, hash: null, timestamp: FINAL_TIMESTAMP };
        }
        return {
          number: FINAL_NUMBER,
          hash: FINAL_HASH,
          timestamp: FINAL_TIMESTAMP,
        };
      }
      const number = blockNumber ?? FINAL_NUMBER;
      if (number === SETTLEMENT_BLOCK && options.settlementBlockError) {
        throw new Error(options.settlementBlockError);
      }
      if (number === SETTLEMENT_BLOCK) {
        return {
          number,
          hash: SETTLEMENT_HASH,
          timestamp: SETTLEMENT_TIMESTAMP,
        };
      }
      return {
        number,
        hash: `0x${"3".repeat(64)}`,
        timestamp: FINAL_TIMESTAMP - (FINAL_NUMBER - number) * 2n,
      };
    },
  );
  const getBytecode = vi.fn(async () => {
    if (options.bytecodeError) throw new Error(options.bytecodeError);
    return options.bytecode ?? "0x60006000";
  });
  const readContract = vi.fn(async () => {
    if (options.authorizationStateError) {
      throw new Error(options.authorizationStateError);
    }
    return options.authorizationUsed ?? false;
  });
  const getLogs = vi.fn(async (query: { fromBlock: bigint; toBlock: bigint }) => {
    if (options.logsError) throw new Error(options.logsError);
    return (options.logs ?? []).filter((candidate) => {
      const blockNumber = (candidate as { blockNumber?: unknown }).blockNumber;
      return (
        typeof blockNumber !== "bigint" ||
        (blockNumber >= query.fromBlock && blockNumber <= query.toBlock)
      );
    });
  });
  const getTransactionReceipt = vi.fn(async () => {
    if (options.receiptError) throw new Error(options.receiptError);
    return {
      status: options.receiptStatus ?? "success",
      blockNumber: options.receiptBlock ?? SETTLEMENT_BLOCK,
      blockHash: options.receiptBlockHash ?? SETTLEMENT_HASH,
      transactionHash: options.receiptTransactionHash ?? TX,
      logs: options.receiptLogs ?? [authUsedLog, transferLog()],
    };
  });

  return {
    client: {
      getChainId,
      getBlock,
      getBytecode,
      readContract,
      getLogs,
      getTransactionReceipt,
    } as unknown as PublicClient,
    calls: {
      getChainId,
      getBlock,
      getBytecode,
      readContract,
      getLogs,
      getTransactionReceipt,
    },
  };
}

async function look(options: FakeOptions = {}) {
  const fake = fakeClient(options);
  const status = await new ViemChainReader({ client: fake.client }).findPayment({
    quote,
    nonce: NONCE,
    payer: PAYER,
    validBefore: VALID_BEFORE,
    heldAt: HELD_AT,
  });
  return { status, calls: fake.calls };
}

const finalizedProof = {
  chainId: SETTLEMENT_PROFILE.chainId,
  number: FINAL_NUMBER,
  hash: FINAL_HASH,
  timestamp: FINAL_TIMESTAMP,
};

describe("the reader checks its fixed settlement rail", () => {
  it("declares only the Base Sepolia Circle USDC profile", () => {
    const reader = new ViemChainReader({ client: fakeClient().client });
    expect(reader.profile).toEqual(SETTLEMENT_PROFILE);
    expect(Object.isFrozen(reader.profile)).toBe(true);
  });

  it("assertReady checks chain, finalized support, and pinned-token bytecode", async () => {
    const fake = fakeClient();
    await expect(
      new ViemChainReader({ client: fake.client }).assertReady(),
    ).resolves.toBeUndefined();
    expect(fake.calls.getChainId).toHaveBeenCalledOnce();
    expect(fake.calls.getBlock).toHaveBeenCalledWith({ blockTag: "finalized" });
    expect(fake.calls.getBytecode).toHaveBeenCalledWith({
      address: SETTLEMENT_PROFILE.asset,
      blockNumber: FINAL_NUMBER,
    });
  });

  it("rejects a wrong-chain RPC before it can carry authority", async () => {
    const fake = fakeClient({ chainId: 1 });
    await expect(
      new ViemChainReader({ client: fake.client }).assertReady(),
    ).rejects.toThrow("wrong_chain");
    expect(fake.calls.readContract).not.toHaveBeenCalled();
    expect(fake.calls.getBytecode).not.toHaveBeenCalled();
  });

  it("rejects an RPC without a usable finalized block before authority", async () => {
    const fake = fakeClient({ finalizedError: "provider secret MUST_NOT_LEAK" });
    const reader = new ViemChainReader({ client: fake.client });
    await expect(reader.assertReady()).rejects.toThrow("finalized_block_unavailable");
    await expect(reader.assertReady()).rejects.not.toThrow("MUST_NOT_LEAK");
    expect(fake.calls.getBytecode).not.toHaveBeenCalled();
  });

  it("rejects missing bytecode at the pinned USDC address", async () => {
    const fake = fakeClient({ bytecode: "0x" });
    await expect(
      new ViemChainReader({ client: fake.client }).assertReady(),
    ).rejects.toThrow("unsupported_profile");
    expect(fake.calls.getBytecode).toHaveBeenCalledWith({
      address: SETTLEMENT_PROFILE.asset,
      blockNumber: FINAL_NUMBER,
    });
  });

  it("does not leak upstream text when bytecode cannot be read", async () => {
    const fake = fakeClient({ bytecodeError: "https://rpc.invalid/SECRET" });
    const reader = new ViemChainReader({ client: fake.client });
    await expect(reader.assertReady()).rejects.toThrow("rpc_unavailable");
    await expect(reader.assertReady()).rejects.not.toThrow("SECRET");
  });

  it("does not leak an RPC URL or API key through readiness errors", async () => {
    const fake = fakeClient({
      chainIdError: "https://rpc.example/v2/SECRET_API_KEY",
    });
    const reader = new ViemChainReader({ client: fake.client });
    await expect(reader.assertReady()).rejects.toThrow("rpc_unavailable");
    await expect(reader.assertReady()).rejects.not.toThrow("SECRET_API_KEY");
  });

  it("refuses an unsupported network or asset without touching the RPC", async () => {
    const fake = fakeClient();
    const reader = new ViemChainReader({ client: fake.client });
    const wrongNetwork = await reader.findPayment({
      quote: { ...quote, network: "eip155:1" },
      nonce: NONCE,
      payer: PAYER,
      validBefore: VALID_BEFORE,
      heldAt: HELD_AT,
    });
    const wrongAsset = await reader.findPayment({
      quote: {
        ...quote,
        asset: "0x0000000000000000000000000000000000000001",
      },
      nonce: NONCE,
      payer: PAYER,
      validBefore: VALID_BEFORE,
      heldAt: HELD_AT,
    });
    expect(wrongNetwork).toEqual({
      state: "unknown",
      reason: "unsupported_profile",
    });
    expect(wrongAsset).toEqual({
      state: "unknown",
      reason: "unsupported_profile",
    });
    expect(fake.calls.getChainId).not.toHaveBeenCalled();
  });

  it("rechecks chain identity for each reconciliation", async () => {
    const { status } = await look({ chainId: 1 });
    expect(status).toEqual({ state: "unknown", reason: "wrong_chain" });
  });
});

describe("unused authorization proof comes from finalized contract state", () => {
  it("releases only when finalized chain time is strictly past validBefore", async () => {
    const { status, calls } = await look({ authorizationUsed: false, logs: [] });
    expect(status).toEqual({
      state: "unused_expired",
      finalizedBlock: finalizedProof,
    });
    expect(calls.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: SETTLEMENT_PROFILE.asset,
        functionName: "authorizationState",
        args: [PAYER, NONCE],
        blockNumber: FINAL_NUMBER,
      }),
    );
    expect(calls.getLogs).not.toHaveBeenCalled();
  });

  it("does not release at the exact deadline", async () => {
    const fake = fakeClient({ authorizationUsed: false });
    fake.calls.getBlock.mockImplementation(async ({ blockTag, blockNumber }) => {
      if (blockTag === "finalized") {
        return {
          number: FINAL_NUMBER,
          hash: FINAL_HASH,
          timestamp: VALID_BEFORE,
        } as never;
      }
      return {
        number: blockNumber,
        hash: FINAL_HASH,
        timestamp: VALID_BEFORE,
      } as never;
    });
    const status = await new ViemChainReader({
      client: fake.client,
    }).findPayment({
      quote,
      nonce: NONCE,
      payer: PAYER,
      validBefore: VALID_BEFORE,
      heldAt: HELD_AT,
    });
    expect(status).toEqual({
      state: "unknown",
      reason: "authorization_still_live",
    });
  });

  it("local clock or hold-time skew cannot manufacture expiry", async () => {
    const fake = fakeClient({ authorizationUsed: false });
    fake.calls.getBlock.mockImplementation(async ({ blockTag, blockNumber }) => {
      if (blockTag === "finalized") {
        return {
          number: FINAL_NUMBER,
          hash: FINAL_HASH,
          timestamp: VALID_BEFORE - 1n,
        } as never;
      }
      return {
        number: blockNumber,
        hash: FINAL_HASH,
        timestamp: VALID_BEFORE - 1n,
      } as never;
    });
    const status = await new ViemChainReader({
      client: fake.client,
    }).findPayment({
      quote,
      nonce: NONCE,
      payer: PAYER,
      validBefore: VALID_BEFORE,
      heldAt: Number.MAX_SAFE_INTEGER,
    });
    expect(status).toEqual({
      state: "unknown",
      reason: "authorization_still_live",
    });
  });

  it("an unreadable authorization state is unknown, never unused", async () => {
    const { status } = await look({
      authorizationStateError: "rpc-key=DO_NOT_LEAK",
    });
    expect(status).toEqual({
      state: "unknown",
      reason: "authorization_state_unavailable",
    });
    expect(JSON.stringify(status)).not.toContain("DO_NOT_LEAK");
  });

  it("requires a well-formed nonce, payer, deadline, and hold time", async () => {
    const fake = fakeClient();
    const reader = new ViemChainReader({ client: fake.client });
    const status = await reader.findPayment({
      quote,
      nonce: "not-a-nonce",
      payer: PAYER,
      validBefore: -1n,
      heldAt: Number.NaN,
    });
    expect(status).toEqual({ state: "unknown", reason: "malformed_query" });
    expect(fake.calls.getChainId).not.toHaveBeenCalled();
  });
});

describe("used authorizations require exact finalized transfer evidence", () => {
  it("settles only the exact nonce/token/from/to/value transfer", async () => {
    const { status } = await look({
      authorizationUsed: true,
      logs: [authUsedLog],
    });
    expect(status).toEqual({
      state: "settled",
      transaction: TX,
      settlementAt: Number(SETTLEMENT_TIMESTAMP) * 1000,
      finalizedBlock: finalizedProof,
    });
  });

  it("binds the closest token Transfer after this nonce's auth log", async () => {
    const lateAuthLog = { ...authUsedLog, logIndex: 40 };
    const { status } = await look({
      authorizationUsed: true,
      logs: [lateAuthLog],
      receiptLogs: [
        lateAuthLog,
        transferLog({ to: STRANGER, logIndex: 41 }),
        transferLog({ to: SELLER, logIndex: 50 }),
      ],
    });
    expect(status).toEqual({
      state: "unknown",
      reason: "settlement_mismatch",
    });
  });

  for (const [name, log] of [
    ["payee", transferLog({ to: STRANGER })],
    ["payer", transferLog({ from: STRANGER })],
    ["amount", transferLog({ value: quote.amount + 1n })],
    ["token", transferLog({ address: STRANGER })],
  ] as const) {
    it(`rejects a mismatched ${name}`, async () => {
      const { status } = await look({
        authorizationUsed: true,
        logs: [authUsedLog],
        receiptLogs: [authUsedLog, log],
      });
      expect(status).toEqual({
        state: "unknown",
        reason: "settlement_mismatch",
      });
    });
  }

  it("missing AuthorizationUsed logs are never negative evidence", async () => {
    const { status } = await look({ authorizationUsed: true, logs: [] });
    expect(status).toEqual({
      state: "unknown",
      reason: "authorization_used_log_missing",
    });
  });

  it("rejects a getLogs authorization absent or inconsistent in the receipt", async () => {
    for (const receiptAuthorization of [
      undefined,
      { ...authUsedLog, logIndex: authUsedLog.logIndex + 1 },
      {
        ...authUsedLog,
        topics: [AUTHORIZATION_USED_TOPIC, topic(PAYER), `0x${"44".repeat(32)}`],
      },
    ]) {
      const receiptLogs = receiptAuthorization
        ? [receiptAuthorization, transferLog()]
        : [transferLog()];
      const { status } = await look({
        authorizationUsed: true,
        logs: [authUsedLog],
        receiptLogs,
      });
      expect(status).toEqual({
        state: "unknown",
        reason: "settlement_mismatch",
      });
    }
  });

  it("rejects a returned authorization log that does not prove the exact query", async () => {
    for (const log of [
      { ...authUsedLog, address: STRANGER },
      {
        ...authUsedLog,
        topics: [AUTHORIZATION_USED_TOPIC, topic(STRANGER), NONCE],
      },
      {
        ...authUsedLog,
        topics: [AUTHORIZATION_USED_TOPIC, topic(PAYER), `0x${"99".repeat(32)}`],
      },
    ]) {
      const { status } = await look({ authorizationUsed: true, logs: [log] });
      expect(status).toEqual({
        state: "unknown",
        reason: "authorization_used_log_missing",
      });
    }
  });

  it("adversarial future hold time can only miss positive evidence, never release", async () => {
    const fake = fakeClient({ authorizationUsed: true, logs: [authUsedLog] });
    const status = await new ViemChainReader({
      client: fake.client,
    }).findPayment({
      quote,
      nonce: NONCE,
      payer: PAYER,
      validBefore: VALID_BEFORE,
      heldAt: Number.MAX_SAFE_INTEGER,
    });
    expect(status).toEqual({
      state: "unknown",
      reason: "authorization_used_log_missing",
    });
    expect(status.state).not.toBe("unused_expired");
  });

  it("a truncated or failed log search is unknown and cannot release", async () => {
    const { status } = await look({
      authorizationUsed: true,
      logsError: "https://rpc.example/SECRET",
    });
    expect(status).toEqual({ state: "unknown", reason: "rpc_unavailable" });
    expect(JSON.stringify(status)).not.toContain("SECRET");
  });

  it("an unreadable receipt is unknown without upstream text", async () => {
    const { status } = await look({
      authorizationUsed: true,
      logs: [authUsedLog],
      receiptError: "provider token SECRET",
    });
    expect(status).toEqual({
      state: "unknown",
      reason: "settlement_receipt_unavailable",
    });
    expect(JSON.stringify(status)).not.toContain("SECRET");
  });

  it("requires the auth log and receipt to name the same finalized block", async () => {
    const { status } = await look({
      authorizationUsed: true,
      logs: [authUsedLog],
      receiptBlock: SETTLEMENT_BLOCK + 1n,
    });
    expect(status).toEqual({
      state: "unknown",
      reason: "settlement_mismatch",
    });
  });

  it("requires the receipt and bound transfer to prove the same transaction", async () => {
    const wrongReceipt = await look({
      authorizationUsed: true,
      logs: [authUsedLog],
      receiptTransactionHash: `0x${"77".repeat(32)}`,
    });
    expect(wrongReceipt.status).toEqual({
      state: "unknown",
      reason: "settlement_mismatch",
    });

    const wrongTransfer = await look({
      authorizationUsed: true,
      logs: [authUsedLog],
      receiptLogs: [
        authUsedLog,
        { ...transferLog(), transactionHash: `0x${"88".repeat(32)}` },
      ],
    });
    expect(wrongTransfer.status).toEqual({
      state: "unknown",
      reason: "settlement_mismatch",
    });
  });

  it("uses the settlement block's chain timestamp, not the local clock", async () => {
    const { status } = await look({
      authorizationUsed: true,
      logs: [authUsedLog],
    });
    expect(status.state).toBe("settled");
    if (status.state === "settled") {
      expect(status.settlementAt).toBe(Number(SETTLEMENT_TIMESTAMP) * 1000);
      expect(status.settlementAt).not.toBe(HELD_AT);
    }
  });
});

describe("ABI and query regression checks", () => {
  it("derives both event topics from their canonical ABIs", () => {
    expect(AUTHORIZATION_USED_TOPIC).toBe(
      toEventSelector("AuthorizationUsed(address,bytes32)"),
    );
    expect(TRANSFER_TOPIC).toBe(
      toEventSelector("Transfer(address,address,uint256)"),
    );
  });

  it("queries the exact AuthorizationUsed nonce and fixed USDC contract", async () => {
    const fake = fakeClient({
      authorizationUsed: true,
      logs: [authUsedLog],
    });
    await new ViemChainReader({ client: fake.client }).findPayment({
      quote,
      nonce: NONCE,
      payer: PAYER,
      validBefore: VALID_BEFORE,
      heldAt: HELD_AT,
    });
    expect(fake.calls.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        address: SETTLEMENT_PROFILE.asset,
        args: { authorizer: PAYER, nonce: NONCE },
        toBlock: FINAL_NUMBER,
      }),
    );
  });
});

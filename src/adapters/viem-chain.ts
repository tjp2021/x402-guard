/**
 * Finalized Base Sepolia USDC settlement evidence.
 *
 * Version 0.1 supports one rail only. Under its trusted-single-RPC assumption,
 * the reader checks that endpoint reports the expected chain, asks Circle USDC
 * for the nonce's authorization state at one finalized block, and returns only
 * proof-bearing terminal outcomes:
 *
 * - unused + finalized chain time strictly past validBefore -> safe to release;
 * - used + exact AuthorizationUsed/Transfer match -> safe to settle;
 * - anything else -> unknown, which carries no release authority.
 *
 * Missing logs and local wall time are never negative evidence.
 */

import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  toEventSelector,
  type Log,
  type PublicClient,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  SETTLEMENT_PROFILE,
  type EvidenceQuote,
  type SettlementProfile,
} from "../policy.js";
import type {
  ChainReader,
  ChainUnknownReason,
  FinalizedBlockProof,
  PaymentStatus,
} from "../ports.js";

const AUTHORIZATION_USED = parseAbiItem(
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
);

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const AUTHORIZATION_STATE_ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

/** Base targets a block every ~2s. This seeds a search; block timestamps prove it. */
const NOMINAL_BLOCK_TIME_MS = 2_000;

/** Search before the hold to absorb benign caller/chain clock skew. */
const SAFETY_MARGIN_MS = 30 * 60 * 1000;

/** Bound eth_getLogs ranges so providers cannot silently truncate a wide query. */
const LOG_CHUNK = 2_000n;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const WORD32 = /^0x[0-9a-fA-F]{64}$/;
const RESOURCE_HASH = /^sha256:[0-9a-f]{64}$/;
const MAX_UINT256 = (1n << 256n) - 1n;

export interface ViemChainReaderOptions {
  rpcUrl?: string;
  /** Injected for tests. Production callers should supply rpcUrl, not a client. */
  client?: PublicClient;
}

class SafeChainError extends Error {
  constructor(readonly reason: ChainUnknownReason) {
    super(`x402-guard chain reader: ${reason}`);
  }
}

export class ViemChainReader implements ChainReader {
  readonly profile: SettlementProfile = SETTLEMENT_PROFILE;
  private readonly client: PublicClient;

  constructor(opts: ViemChainReaderOptions = {}) {
    this.client =
      opts.client ??
      (createPublicClient({
        chain: baseSepolia,
        transport: http(opts.rpcUrl),
      }) as PublicClient);
  }

  /**
   * Guard.open calls this before granting authority. Under the documented
   * trusted-single-RPC assumption, it checks that the configured endpoint
   * reports the expected chain, serves a finalized block, and returns deployed
   * code at the pinned token address at that block. This is not independent
   * consensus proof or proof of token semantics; exact authorization/transfer
   * evidence is still required later.
   */
  async assertReady(): Promise<void> {
    const finalized = await this.finalizedBlock();
    let code: string | undefined;
    try {
      code = await this.client.getBytecode({
        address: SETTLEMENT_PROFILE.asset,
        blockNumber: finalized.number,
      });
    } catch {
      throw new SafeChainError("rpc_unavailable");
    }
    if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) {
      throw new SafeChainError("unsupported_profile");
    }
  }

  async findPayment(params: {
    readonly quote: EvidenceQuote;
    readonly nonce: string;
    readonly payer: string;
    readonly validBefore: bigint;
    readonly heldAt: number;
  }): Promise<PaymentStatus> {
    const { quote, nonce, payer, validBefore, heldAt } = params;

    if (
      typeof quote !== "object" ||
      quote === null ||
      typeof quote.network !== "string" ||
      typeof quote.asset !== "string"
    ) {
      return unknown("malformed_query");
    }
    if (!this.supports(quote)) {
      return unknown("unsupported_profile");
    }
    if (
      typeof nonce !== "string" ||
      !HASH32.test(nonce) ||
      typeof payer !== "string" ||
      !ADDRESS.test(payer) ||
      typeof quote.amount !== "bigint" ||
      quote.amount < 0n ||
      quote.amount > MAX_UINT256 ||
      typeof quote.payTo !== "string" ||
      !ADDRESS.test(quote.payTo) ||
      typeof quote.resourceHash !== "string" ||
      !RESOURCE_HASH.test(quote.resourceHash) ||
      typeof validBefore !== "bigint" ||
      validBefore < 0n ||
      validBefore > MAX_UINT256 ||
      !Number.isSafeInteger(heldAt) ||
      heldAt < 0
    ) {
      return unknown("malformed_query");
    }

    let finalized: FinalizedBlockProof;
    try {
      finalized = await this.finalizedBlock();
    } catch (error) {
      return unknown(safeReason(error, "finalized_block_unavailable"));
    }

    let used: boolean;
    try {
      const state = await this.client.readContract({
        address: SETTLEMENT_PROFILE.asset,
        abi: AUTHORIZATION_STATE_ABI,
        functionName: "authorizationState",
        args: [payer as `0x${string}`, nonce as `0x${string}`],
        blockNumber: finalized.number,
      });
      if (typeof state !== "boolean") {
        return unknown("authorization_state_unavailable");
      }
      used = state;
    } catch {
      return unknown("authorization_state_unavailable");
    }

    if (!used) {
      // The authorization cannot land in any later block once finalized chain
      // time has passed its deadline. Equality is still live; require strictly
      // greater chain time.
      if (finalized.timestamp > validBefore) {
        return Object.freeze({ state: "unused_expired", finalizedBlock: finalized });
      }
      return unknown("authorization_still_live");
    }

    // Positive evidence path. A missed log can only withhold settlement; it can
    // never release budget because authorizationState already says "used".
    let authLogs: Log[];
    try {
      const fromBlock = await this.blockAtOrBefore(
        Math.max(0, heldAt - SAFETY_MARGIN_MS),
        finalized,
      );
      authLogs = await this.getAuthorizationLogs(
        payer,
        nonce,
        fromBlock,
        finalized.number,
      );
    } catch {
      return unknown("rpc_unavailable");
    }

    if (authLogs.length !== 1) {
      return unknown("authorization_used_log_missing");
    }
    const authLog = authLogs[0]!;
    if (
      safeAddress(authLog.address) !== safeAddress(SETTLEMENT_PROFILE.asset) ||
      authLog.topics[0]?.toLowerCase() !== AUTHORIZATION_USED_TOPIC.toLowerCase() ||
      topicAddress(authLog.topics[1]) !== safeAddress(payer) ||
      authLog.topics[2]?.toLowerCase() !== nonce.toLowerCase() ||
      authLog.topics.length !== 3 ||
      authLog.data !== "0x" ||
      !authLog.transactionHash ||
      !HASH32.test(authLog.transactionHash)
    ) {
      return unknown("authorization_used_log_missing");
    }

    return this.verifyTransfer(authLog, quote, payer, finalized);
  }

  private supports(quote: EvidenceQuote): boolean {
    return (
      quote.network === SETTLEMENT_PROFILE.network &&
      quote.asset.toLowerCase() === SETTLEMENT_PROFILE.asset.toLowerCase()
    );
  }

  private async finalizedBlock(): Promise<FinalizedBlockProof> {
    let chainId: number;
    try {
      chainId = await this.client.getChainId();
    } catch {
      throw new SafeChainError("rpc_unavailable");
    }
    if (chainId !== SETTLEMENT_PROFILE.chainId) {
      throw new SafeChainError("wrong_chain");
    }

    let block;
    try {
      block = await this.client.getBlock({ blockTag: "finalized" });
    } catch {
      throw new SafeChainError("finalized_block_unavailable");
    }
    if (
      block.number === null ||
      typeof block.number !== "bigint" ||
      block.number < 0n ||
      typeof block.timestamp !== "bigint" ||
      block.timestamp < 0n ||
      typeof block.hash !== "string" ||
      !HASH32.test(block.hash)
    ) {
      throw new SafeChainError("finalized_block_unavailable");
    }

    return Object.freeze({
      chainId,
      number: block.number,
      hash: block.hash,
      timestamp: block.timestamp,
    });
  }

  private async getAuthorizationLogs(
    payer: string,
    nonce: string,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Log[]> {
    const out: Log[] = [];
    for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
      const end =
        start + LOG_CHUNK - 1n < toBlock ? start + LOG_CHUNK - 1n : toBlock;
      const chunk = (await this.client.getLogs({
        address: SETTLEMENT_PROFILE.asset,
        event: AUTHORIZATION_USED,
        args: {
          authorizer: payer as `0x${string}`,
          nonce: nonce as `0x${string}`,
        },
        fromBlock: start,
        toBlock: end,
      } as Parameters<PublicClient["getLogs"]>[0])) as Log[];
      out.push(...chunk);
      if (out.length > 0) break;
    }
    return out;
  }

  private async verifyTransfer(
    authLog: Log,
    quote: EvidenceQuote,
    payer: string,
    finalized: FinalizedBlockProof,
  ): Promise<PaymentStatus> {
    const transaction = authLog.transactionHash!;
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({
        hash: transaction as `0x${string}`,
      });
    } catch {
      return unknown("settlement_receipt_unavailable");
    }

    if (
      receipt.status !== "success" ||
      receipt.blockNumber > finalized.number ||
      authLog.blockNumber !== receipt.blockNumber ||
      authLog.removed === true ||
      !authLog.blockHash ||
      !HASH32.test(authLog.blockHash) ||
      !HASH32.test(receipt.blockHash) ||
      authLog.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      !HASH32.test(receipt.transactionHash) ||
      receipt.transactionHash.toLowerCase() !== transaction.toLowerCase()
    ) {
      return unknown("settlement_mismatch");
    }

    const expected = {
      token: safeAddress(SETTLEMENT_PROFILE.asset),
      from: safeAddress(payer),
      to: safeAddress(quote.payTo),
    };
    if (!expected.token || !expected.from || !expected.to) {
      return unknown("malformed_query");
    }

    const authIndex = authLog.logIndex;
    const receiptAuthorizationLogs =
      authIndex === null
        ? []
        : receipt.logs.filter(
            (log) =>
              safeAddress(log.address) === expected.token &&
              log.topics.length === 3 &&
              log.topics.every(
                (topic, index) =>
                  topic?.toLowerCase() === authLog.topics[index]?.toLowerCase(),
              ) &&
              log.data === "0x" &&
              log.logIndex === authIndex &&
              log.removed !== true &&
              log.blockNumber === receipt.blockNumber &&
              log.blockHash?.toLowerCase() === receipt.blockHash.toLowerCase() &&
              log.transactionHash?.toLowerCase() === transaction.toLowerCase(),
          );
    if (receiptAuthorizationLogs.length !== 1) {
      return unknown("settlement_mismatch");
    }

    const bound =
      authIndex === null
        ? undefined
        : receipt.logs
            .filter(
              (log) =>
                safeAddress(log.address) === expected.token &&
                log.topics[0]?.toLowerCase() === TRANSFER_TOPIC.toLowerCase() &&
                log.logIndex !== null &&
                log.logIndex > authIndex &&
                log.removed !== true &&
                log.blockNumber === receipt.blockNumber &&
                log.blockHash?.toLowerCase() === receipt.blockHash.toLowerCase() &&
                log.transactionHash?.toLowerCase() === transaction.toLowerCase(),
            )
            .sort((a, b) => Number((a.logIndex ?? 0) - (b.logIndex ?? 0)))[0];

    let amountMatches = false;
    try {
      amountMatches =
        bound !== undefined &&
        WORD32.test(bound.data) &&
        BigInt(bound.data) === quote.amount;
    } catch {
      amountMatches = false;
    }

    if (
      !bound ||
      topicAddress(bound.topics[1]) !== expected.from ||
      topicAddress(bound.topics[2]) !== expected.to ||
      !amountMatches
    ) {
      return unknown("settlement_mismatch");
    }

    let settlementBlock;
    try {
      settlementBlock = await this.client.getBlock({
        blockNumber: receipt.blockNumber,
      });
    } catch {
      return unknown("settlement_receipt_unavailable");
    }

    const settlementAt = Number(settlementBlock.timestamp) * 1000;
    if (
      settlementBlock.number !== receipt.blockNumber ||
      !settlementBlock.hash ||
      !HASH32.test(settlementBlock.hash) ||
      settlementBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      settlementBlock.timestamp > finalized.timestamp ||
      !Number.isSafeInteger(settlementAt) ||
      settlementAt < 0
    ) {
      return unknown("settlement_receipt_unavailable");
    }

    return Object.freeze({
      state: "settled",
      transaction,
      settlementAt,
      finalizedBlock: finalized,
    });
  }

  /**
   * Find the last block at or before a timestamp. The finalized block's own
   * timestamp seeds the estimate; Date.now() never participates in release
   * evidence or lookup bounds.
   */
  private async blockAtOrBefore(
    timestampMs: number,
    finalized: FinalizedBlockProof,
  ): Promise<bigint> {
    const targetSec = BigInt(Math.floor(timestampMs / 1000));
    if (finalized.timestamp <= targetSec) return finalized.number;

    const finalizedMs = Number(finalized.timestamp) * 1000;
    if (!Number.isSafeInteger(finalizedMs)) {
      throw new SafeChainError("finalized_block_unavailable");
    }
    const nominalSpan = BigInt(
      Math.ceil(Math.max(0, finalizedMs - timestampMs) / NOMINAL_BLOCK_TIME_MS),
    );
    let lo =
      finalized.number > nominalSpan ? finalized.number - nominalSpan : 0n;

    while (lo > 0n) {
      const block = await this.client.getBlock({ blockNumber: lo });
      if (block.timestamp <= targetSec) break;
      const step =
        finalized.number - lo === 0n ? 1n : (finalized.number - lo) * 2n;
      lo = lo > step ? lo - step : 0n;
    }

    let hi = finalized.number;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      const block = await this.client.getBlock({ blockNumber: mid });
      if (block.timestamp <= targetSec) lo = mid;
      else hi = mid - 1n;
    }
    return lo;
  }
}

export const AUTHORIZATION_USED_TOPIC = toEventSelector(AUTHORIZATION_USED);
export const TRANSFER_TOPIC = toEventSelector(TRANSFER);

function unknown(reason: ChainUnknownReason): PaymentStatus {
  return Object.freeze({ state: "unknown", reason });
}

function safeReason(
  error: unknown,
  fallback: ChainUnknownReason,
): ChainUnknownReason {
  return error instanceof SafeChainError ? error.reason : fallback;
}

function safeAddress(address: string): string | undefined {
  try {
    return getAddress(address);
  } catch {
    return undefined;
  }
}

/** An indexed address topic is left-padded to 32 bytes. */
function topicAddress(topic: string | undefined): string | undefined {
  if (!topic || topic.length !== 66) return undefined;
  return safeAddress(`0x${topic.slice(26)}`);
}

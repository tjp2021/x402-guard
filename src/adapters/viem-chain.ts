/**
 * The chain reader: asks Base Sepolia what actually settled.
 *
 * Two questions, and answering only the first is a hole big enough to drive a
 * budget through:
 *
 * 1. WAS an authorization used?
 *
 *    x402 settles USDC via EIP-3009 `transferWithAuthorization`. The payer signs
 *    an off-chain authorization carrying a unique `nonce`; USDC emits
 *
 *        event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)
 *
 *    exactly once per authorization, and reverts on replay. So a lookup keyed on
 *    (authorizer, nonce) has exactly one answer. Amount+payee alone would be
 *    ambiguous the moment an agent pays the same seller the same amount twice.
 *
 * 2. WAS IT THE ONE WE AUTHORIZED?
 *
 *    `AuthorizationUsed` carries NO value and NO recipient. A reader that stops
 *    at question 1 will confirm that *something* was paid, record the quote it
 *    *expected*, and cite a real transaction hash as proof — while the money
 *    actually went elsewhere, in a different amount. The ledger would assert a
 *    falsehood and staple a receipt to it. The audit trail, which is the whole
 *    product, becomes the instrument of the lie.
 *
 *    So we pull the settlement receipt and check the ERC-20
 *    `Transfer(from, to, value)` log against the quote: same token, same payer,
 *    same recipient, same amount. A mismatch is NOT "not found" — it is
 *    "unknown", because money demonstrably moved and a human must look.
 *
 * Nothing here decides policy. It reports what the chain says, including that
 * the chain said nothing.
 */

import {
  createPublicClient,
  http,
  parseAbiItem,
  getAddress,
  toEventSelector,
  type Log,
  type PublicClient,
} from "viem";
import { baseSepolia } from "viem/chains";
import type { ChainReader, PaymentStatus } from "../ports.js";
import type { Quote } from "../policy.js";

const AUTHORIZATION_USED = parseAbiItem(
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
);

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Base targets a block every ~2s. Used only to seed a search, never to trust one. */
const NOMINAL_BLOCK_TIME_MS = 2_000;

/** How far before the hold to start looking, absorbing clock skew. */
const SAFETY_MARGIN_MS = 30 * 60 * 1000;

export interface ViemChainReaderOptions {
  rpcUrl?: string;
  /** Injected for tests. */
  client?: PublicClient;
}

export class ViemChainReader implements ChainReader {
  private readonly client: PublicClient;

  constructor(opts: ViemChainReaderOptions = {}) {
    this.client =
      opts.client ??
      (createPublicClient({
        chain: baseSepolia,
        transport: http(opts.rpcUrl),
      }) as PublicClient);
  }

  async findPayment(params: {
    quote: Quote;
    nonce: string;
    payer: string;
    heldAt: number;
  }): Promise<PaymentStatus> {
    const { quote, nonce, payer, heldAt } = params;

    // A malformed query returns an empty log set, and reading THAT as "the
    // payment never happened" would release a hold on the strength of our own
    // bug. Refuse to answer instead.
    if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
      return { found: "unknown", reason: `nonce is not a 32-byte hash: ${nonce}` };
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(payer)) {
      return { found: "unknown", reason: `payer is not an address: ${payer}` };
    }

    let fromBlock: bigint;
    let latest: bigint;
    try {
      latest = await this.client.getBlockNumber();
      fromBlock = await this.blockAtOrBefore(heldAt - SAFETY_MARGIN_MS, latest);
    } catch (e) {
      return { found: "unknown", reason: `RPC error resolving search range: ${msg(e)}` };
    }

    let logs: Log[];
    try {
      // Query in bounded chunks, not one open-ended range. A 24h-old hold spans
      // tens of thousands of blocks; a single getLogs over that either errors
      // (safe — caught below) or, on some providers, SILENTLY truncates to the
      // provider's cap. A truncated result that drops an older settlement reads
      // as "not found" and releases the hold — the double-spend. Chunking makes
      // every block in the interval provably covered.
      logs = await this.getLogsChunked(quote.asset, payer, nonce, fromBlock, latest);
    } catch (e) {
      // An RPC that cannot answer is not an RPC saying "no". Collapsing those
      // two is how a hold gets released for money that already left.
      return { found: "unknown", reason: `RPC error: ${msg(e)}` };
    }

    const log = logs[0];
    if (!log) {
      // The authorization was never used. USDC emits this event on every use and
      // reverts on replay, and the search provably covers the whole interval
      // since the hold — so its absence is real evidence, not merely an absence
      // of information.
      return { found: false };
    }

    if (!log.transactionHash) {
      return { found: "unknown", reason: "settlement log has no transaction hash yet" };
    }

    // Question 2. The authorization was used — but for what?
    return await this.verifyTransfer(log, quote, payer);
  }

  /**
   * getLogs over [fromBlock, toBlock], in bounded chunks so no provider range
   * cap can silently truncate the result. Each chunk's errors propagate (a
   * failed chunk means the interval is not provably covered, which the caller
   * turns into `unknown`, never `found:false`).
   */
  private async getLogsChunked(
    asset: string,
    payer: string,
    nonce: string,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Log[]> {
    const CHUNK = 2_000n; // comfortably under common eth_getLogs range caps
    const out: Log[] = [];
    for (let start = fromBlock; start <= toBlock; start += CHUNK) {
      const end = start + CHUNK - 1n < toBlock ? start + CHUNK - 1n : toBlock;
      const chunk = (await this.client.getLogs({
        address: asset as `0x${string}`,
        event: AUTHORIZATION_USED,
        args: {
          authorizer: payer as `0x${string}`,
          nonce: nonce as `0x${string}`,
        },
        fromBlock: start,
        toBlock: end,
      } as Parameters<PublicClient["getLogs"]>[0])) as Log[];
      out.push(...chunk);
      if (out.length > 0) break; // the nonce is unique; one hit is the answer
    }
    return out;
  }

  /**
   * Confirm the settlement actually moved the money the quote described, and
   * that THIS nonce's transfer is the one that did.
   *
   * A mismatch means money moved in a way we did not authorize. That is never
   * "not found" (which would release the hold and free the budget); it is a
   * loud "unknown" that a human must resolve.
   *
   * The transfer is bound to the specific AuthorizationUsed log, not to "any
   * matching transfer in the receipt". Circle's USDC (FiatTokenV2) marks the
   * nonce used, THEN transfers — so `transferWithAuthorization` emits
   * `AuthorizationUsed` first and the `Transfer` immediately after. This nonce's
   * transfer is therefore the token transfer with the smallest logIndex ABOVE
   * this auth log's. (Verified on Base Sepolia: auth at logIndex 40, transfer at
   * 41.) Without that binding, a batched settlement of two of our own holds lets
   * hold-A confirm on hold-B's transfer.
   */
  private async verifyTransfer(
    authLog: Log,
    quote: Quote,
    payer: string,
  ): Promise<PaymentStatus> {
    const transaction = authLog.transactionHash!;
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({
        hash: transaction as `0x${string}`,
      });
    } catch (e) {
      return {
        found: "unknown",
        reason: `authorization ${transaction} was used, but its receipt is unreadable: ${msg(e)}`,
      };
    }

    const expected = {
      token: safeAddress(quote.asset),
      from: safeAddress(payer),
      to: safeAddress(quote.payTo),
    };
    if (!expected.token || !expected.from || !expected.to) {
      return { found: "unknown", reason: "quote or payer contains a malformed address" };
    }

    // The token transfer that this exact AuthorizationUsed settled: same token,
    // and the closest transfer emitted AFTER this auth log. Circle's USDC emits
    // AuthorizationUsed, then Transfer — so this nonce's transfer is the one with
    // the smallest logIndex above this auth log's. In a batched settlement
    // (Auth_A, Transfer_A, Auth_B, Transfer_B), "least above" pairs each auth
    // with its own transfer.
    const authIndex = authLog.logIndex;
    const bound =
      authIndex === null
        ? undefined
        : receipt.logs
            .filter(
              (l) =>
                safeAddress(l.address) === expected.token &&
                l.topics[0] === TRANSFER_TOPIC &&
                l.logIndex !== null &&
                l.logIndex > authIndex,
            )
            .sort((a, b) => (a.logIndex ?? 0) - (b.logIndex ?? 0))[0];

    const matches =
      bound !== undefined &&
      topicAddress(bound.topics[1]) === expected.from &&
      topicAddress(bound.topics[2]) === expected.to &&
      BigInt(bound.data) === quote.amount;

    if (!matches) {
      // The authorization was used and money moved — but the transfer this nonce
      // settled is not the one we authorized. Confirming would make the ledger
      // assert a payment that did not happen and cite a real transaction as proof.
      return {
        found: "unknown",
        reason:
          `authorization was used in ${transaction}, but the transfer it settled is not ` +
          `${quote.amount} of ${quote.asset} from ${payer} to ${quote.payTo}. ` +
          `The settlement does not match the authorized quote.`,
      };
    }

    return { found: true, transaction };
  }

  /**
   * The last block at or before a timestamp, found by binary search.
   *
   * Derived from real block timestamps rather than multiplied from a nominal
   * block time. A nominal figure has unbounded error in the unsafe direction: if
   * blocks land faster than assumed, a fixed block-count window covers less wall
   * time than intended, the search silently starts after the settlement, and the
   * caller reads the empty result as "the payment never happened".
   */
  private async blockAtOrBefore(timestampMs: number, latest: bigint): Promise<bigint> {
    const targetSec = BigInt(Math.floor(timestampMs / 1000));

    const latestBlock = await this.client.getBlock({ blockNumber: latest });
    if (latestBlock.timestamp <= targetSec) return latest;

    // Seed a lower bound with the nominal rate, then walk it back until it
    // provably precedes the target. Guessing low is safe; guessing high is not.
    const nominalSpan = BigInt(
      Math.ceil((Date.now() - timestampMs) / NOMINAL_BLOCK_TIME_MS),
    );
    let lo = latest > nominalSpan ? latest - nominalSpan : 0n;

    while (lo > 0n) {
      const block = await this.client.getBlock({ blockNumber: lo });
      if (block.timestamp <= targetSec) break;
      const step = latest - lo === 0n ? 1n : (latest - lo) * 2n;
      lo = lo > step ? lo - step : 0n;
    }

    let hi = latest;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      const block = await this.client.getBlock({ blockNumber: mid });
      if (block.timestamp <= targetSec) lo = mid;
      else hi = mid - 1n;
    }
    return lo;
  }
}

// Derived from the ABI, not hard-coded. If the event signature is wrong, this
// selector is wrong and the match fails loudly — rather than a copy-pasted hex
// constant that stays "correct" while the ABI drifts out from under it.
export const TRANSFER_TOPIC = toEventSelector(TRANSFER);

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function safeAddress(a: string): string | undefined {
  try {
    return getAddress(a);
  } catch {
    return undefined;
  }
}

/** An indexed address topic is left-padded to 32 bytes. */
function topicAddress(topic: string | undefined): string | undefined {
  if (!topic || topic.length !== 66) return undefined;
  return safeAddress(`0x${topic.slice(26)}`);
}

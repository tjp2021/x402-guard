/** I/O contracts for the fail-closed composition root. */

import type { Entry } from "./ledger.js";
import type { EvidenceQuote, SettlementProfile } from "./policy.js";

export interface Clock {
  /** Trusted policy/budget time source, in unix milliseconds. */
  now(): number;
}

/** Trusted durability boundary. Guard cannot prove a custom adapter actually fsyncs. */
export interface LedgerStore {
  /** Must durably append and fsync before resolving. */
  append(entry: Entry): Promise<void>;
  /** Strictly decoded, oldest first. */
  readAll(): Promise<Entry[]>;
}

export interface FinalizedBlockProof {
  readonly chainId: number;
  readonly number: bigint;
  readonly hash: string;
  /** Unix seconds from the finalized block. */
  readonly timestamp: bigint;
}

export const CHAIN_UNKNOWN_REASONS = Object.freeze([
  "rpc_unavailable",
  "wrong_chain",
  "unsupported_profile",
  "finalized_block_unavailable",
  "authorization_state_unavailable",
  "authorization_still_live",
  "authorization_used_log_missing",
  "settlement_receipt_unavailable",
  "settlement_mismatch",
  "malformed_query",
] as const);

export type ChainUnknownReason = (typeof CHAIN_UNKNOWN_REASONS)[number];

/**
 * Only these proof-bearing outcomes may drive a terminal ledger transition.
 * `unknown` is deliberately incapable of carrying release authority.
 */
export type PaymentStatus =
  | {
      readonly state: "settled";
      readonly transaction: string;
      /** Verified settlement block time, unix milliseconds. */
      readonly settlementAt: number;
      readonly finalizedBlock: FinalizedBlockProof;
    }
  | {
      readonly state: "unused_expired";
      readonly finalizedBlock: FinalizedBlockProof;
    }
  | {
      readonly state: "unknown";
      readonly reason: ChainUnknownReason;
    };

export interface ChainReader {
  /** Trusted proof adapter; Guard structurally validates but cannot recreate its RPC reads. */
  readonly profile: SettlementProfile;
  /** Must fail if the RPC cannot prove the declared supported profile. */
  assertReady(): Promise<void>;
  findPayment(params: {
    readonly quote: EvidenceQuote;
    readonly nonce: string;
    readonly payer: string;
    /** Canonical EIP-3009 unix seconds. */
    readonly validBefore: bigint;
    /** Hold time, unix milliseconds; only bounds positive-evidence lookup. */
    readonly heldAt: number;
  }): Promise<PaymentStatus>;
}

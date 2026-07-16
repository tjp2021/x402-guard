import { loadPolicy } from "../src/load.js";
import type { LoadedPolicy } from "../src/load.js";
import type { Entry } from "../src/ledger.js";
import { SETTLEMENT_PROFILE } from "../src/policy.js";
import type { Quote } from "../src/policy.js";
import type {
  ChainReader,
  Clock,
  FinalizedBlockProof,
  LedgerStore,
  PaymentStatus,
} from "../src/ports.js";

export const NOW = 1_700_000_000_000;
export const PAYEE = "0x1111111111111111111111111111111111111111";
export const PAYER = "0x2222222222222222222222222222222222222222";
export const NONCE = `0x${"33".repeat(32)}`;
export const TX = `0x${"44".repeat(32)}`;
export const BLOCK_HASH = `0x${"55".repeat(32)}`;

export function policyDocument(): Record<string, unknown> {
  return {
    policy: "test-agent",
    version: 1,
    asset: {
      symbol: "USDC",
      address: SETTLEMENT_PROFILE.asset,
      network: SETTLEMENT_PROFILE.network,
      decimals: SETTLEMENT_PROFILE.decimals,
    },
    mandate: {
      holder: "fixture-holder",
      agent: "fixture-agent",
      expires: new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
    payees: { allow: [{ name: "fixture-payee", address: PAYEE }] },
    payments: { max_per_payment: "10.00", require_approval_over: "5.00" },
    budgets: [
      { name: "hourly", window: "rolling-1h", limit: "20.00" },
      { name: "daily", window: "rolling-24h", limit: "50.00" },
    ],
    velocity: { max_payments_per_hour: 100 },
  };
}

export function loadedPolicy(): LoadedPolicy {
  return loadPolicy(policyDocument(), NOW);
}

export function quote(amount = 1_000_000n): Quote {
  return {
    amount,
    asset: SETTLEMENT_PROFILE.asset,
    network: SETTLEMENT_PROFILE.network,
    payTo: PAYEE,
    resource: "https://seller.test/report",
  };
}

export function finalizedBlock(timestamp: bigint): FinalizedBlockProof {
  return {
    chainId: SETTLEMENT_PROFILE.chainId,
    number: 12_345n,
    hash: BLOCK_HASH,
    timestamp,
  };
}

export class TestClock implements Clock {
  constructor(public value = NOW) {}
  now(): number {
    return this.value;
  }
}

export class MemoryStore implements LedgerStore {
  readonly entries: Entry[];
  appendCalls = 0;
  failNextAppend = false;

  constructor(entries: readonly Entry[] = []) {
    this.entries = [...entries];
  }

  async append(entry: Entry): Promise<void> {
    this.appendCalls += 1;
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("fixture append failure");
    }
    this.entries.push(entry);
  }

  async readAll(): Promise<Entry[]> {
    return [...this.entries];
  }
}

export class TestChain implements ChainReader {
  readonly profile = SETTLEMENT_PROFILE;
  ready = true;
  status: unknown = { state: "unknown", reason: "authorization_still_live" };
  calls = 0;

  async assertReady(): Promise<void> {
    if (!this.ready) throw new Error("fixture RPC details must not escape");
  }

  async findPayment(): Promise<PaymentStatus> {
    this.calls += 1;
    return this.status as PaymentStatus;
  }
}

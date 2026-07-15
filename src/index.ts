/**
 * x402-guard — a spending policy that holds across an agent's whole session.
 *
 * The composition root is `Guard`. Everything else here is exported so a caller
 * can build their own wiring, inspect a verdict, or plug in a different store or
 * chain reader.
 */

export { Guard } from "./guard.js";
export type { GuardOptions, Authorization } from "./guard.js";

export { loadPolicy, hashPolicy, PolicyError } from "./load.js";
export { loadPolicyFile } from "./load-file.js";
export { evaluate, quoteHash } from "./evaluate.js";
export { Ledger, LedgerError } from "./ledger.js";
export type { Entry, HoldStatus } from "./ledger.js";
export { sweep } from "./reconcile.js";
export type { ReconcileResult, ReconcileOptions } from "./reconcile.js";

export { parseDecimal, parseAtomic, formatAmount, AmountError } from "./amount.js";
export type { Atomic } from "./amount.js";

export { JsonlLedgerStore } from "./adapters/jsonl-store.js";
export { ViemChainReader } from "./adapters/viem-chain.js";
export type { ViemChainReaderOptions } from "./adapters/viem-chain.js";

export type {
  Policy,
  Quote,
  Verdict,
  Decision,
  Reason,
  Budget,
  BudgetWindow,
  BudgetState,
  Payee,
} from "./policy.js";
export type {
  Clock,
  LedgerStore,
  ChainReader,
  PaymentStatus,
} from "./ports.js";

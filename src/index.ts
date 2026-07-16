/**
 * x402-guard — a spending policy that holds across an agent's whole session.
 *
 * The composition root is `Guard`. Lifecycle proposal/apply and reconciliation
 * internals deliberately stay off the package surface. Callers can inspect
 * immutable evidence; supplied stores, readers, clocks, and signers are explicit
 * trusted-computing-base dependencies and must honor their documented contracts.
 */

export { AuthorityExposureError, Guard, GuardFaultError } from "./guard.js";
export type { GuardOptions, Authorization } from "./guard.js";

export { loadPolicy, hashPolicy, isLoadedPolicy, PolicyError } from "./load.js";
export type { LoadedPolicy } from "./load.js";
export { loadPolicyFile } from "./load-file.js";
export { LedgerError } from "./ledger.js";
export type {
  Entry,
  HoldStatus,
  LedgerReason,
  IndeterminateReason,
  AuthorizationFields,
} from "./ledger.js";
export type { ReconcileResult } from "./reconcile.js";

export { parseDecimal, parseAtomic, formatAmount, AmountError } from "./amount.js";
export type { Atomic } from "./amount.js";

export { JsonlLedgerStore } from "./adapters/jsonl-store.js";
export { ViemChainReader } from "./adapters/viem-chain.js";
export {
  X402GuardLifecycleError,
  x402GuardHooks,
} from "./adapters/x402.js";
export type { X402GuardHooks } from "./adapters/x402.js";
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
  EvidenceQuote,
  SettlementProfile,
} from "./policy.js";
export { SETTLEMENT_PROFILE } from "./policy.js";
export { CHAIN_UNKNOWN_REASONS } from "./ports.js";
export type {
  Clock,
  LedgerStore,
  ChainReader,
  PaymentStatus,
  ChainUnknownReason,
  FinalizedBlockProof,
} from "./ports.js";

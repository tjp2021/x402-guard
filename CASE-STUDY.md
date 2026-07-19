# Designing a fail-closed spending guard for x402 agents

## Executive summary

The x402 SDK provides per-attempt payment lifecycle hooks, but a bare hook does
not supply durable cumulative spending policy or recovery for ambiguous signed
authorizations. I built `x402-guard` as an independent, testnet-only reference
implementation: it reserves budget before a supported x402 signer receives the
payment requirements and keeps uncertain authority committed until finalized
Base Sepolia evidence resolves it under a trusted-RPC assumption.

This is a reference implementation first and an installable package second.
Its purpose is to make the failure mode concrete and to provide inspectable
design and tests for the hard parts: money, concurrency, durability, and
partial failure.

## The public problem

A per-payment limit is not a cumulative mandate. With a $5.00 rolling budget,
three individually valid $1.80 requests project to $5.40. A safe buyer needs
state shared across attempts and must reserve budget before exposing payment
authority, or concurrent check-then-pay operations can both pass.

The second problem begins after signature. An EIP-3009 authorization remains
usable until its deadline. A timeout, crash, or facilitator error does not prove
that the authorization was unused. Releasing its hold and retrying can expose
authority beyond the mandate.

These concerns are visible in the ecosystem. The x402 project has a public
[payment-integrity proposal](https://github.com/x402-foundation/x402/issues/2823)
covering price, asset, network, and recipient validation. Coinbase's managed
[Agentic Wallet limits](https://docs.cdp.coinbase.com/agentic-wallet/mcp/faq)
validate spending controls as a category. `x402-guard` is an independent,
application-owned exploration of the same broader problem, not a claim of
uniqueness or official status.

## What I built

```text
402 requirements
       |
       v
strict boundary validation
       |
       v
policy evaluation -> append + fsync durable hold
       |
       v
EIP-3009 signing -> attach exact authorization
       |
       v
facilitator response (hint only)
       |
       v
finalized RPC evidence
   |             |             |
settled       released       unknown
exact receipt unused after   remain
+ Transfer    expiry         committed
```

The policy supports allowlisted payees, per-payment caps, rolling budgets,
velocity limits, and caller-attested approval. The evidence ledger stores
bounded reason codes and hashes resource identifiers instead of persisting raw
URLs, upstream errors, or signatures.

## Hardest engineering decisions

### Hold before authority

The bundled JSONL adapter appends and fsyncs the hold before `ALLOW` returns.
That turns policy evaluation and reservation into one serialized durability
boundary instead of a check followed by an unrecorded payment race.

### Unknown is a real state

An RPC failure, missing receipt, unfinalized transaction, or still-live
authorization is not evidence that money did not move. The reconciler keeps the
hold committed. Release requires finalized unused-nonce state and chain time
strictly past `validBefore`.

### Facilitator success is not settlement evidence

A success response records only a transaction hint. Settlement requires the
receipt-local authorization event and a matching USDC Transfer with the expected
token, payer, recipient, amount, block, and transaction.

### The signing handoff is part of the security boundary

A durable `held` entry blocks another signing attempt until the exact
authorization or a generic exact-signer outcome is recorded. If the observed
signed payload is unreadable or economically mismatched, an irreversible
authority-exposure latch blocks new payment authority across restart.

## What changed as the assumptions were attacked

The implementation became narrower and more conservative as its assumptions
were attacked. The work added or strengthened:

- exact runtime dependency pins because hook order and payload shape matter;
- rejection of Permit2, unknown signing metadata, server extensions, mutable
  hook inputs, and overlong server-declared authorization windows;
- durable signing-gap and exposure latches;
- receipt-local authorization and exact Transfer binding;
- strict ledger transitions and append-before-apply behavior;
- explicit trusted-RPC, trusted-signer, single-writer, and hook-ordering
  assumptions;
- tests that were required to fail when representative protections were
  deliberately removed.

The design history is preserved in
[docs/design-decisions.md](./docs/design-decisions.md), including approaches that
were reversed rather than hidden from the final narrative.

## Verification evidence

The 0.1.0 release has:

- 205 deterministic tests;
- strict project and standalone example/script TypeScript checks;
- a clean build and clean-room package import/declaration check;
- full and production dependency audits with no known vulnerabilities at the
  time of preparation;
- repository-history and extracted-package secret scans;
- spot checks confirming that load-bearing regressions fail when their
  protections are deliberately removed.

These are local verification results, not an independent security audit. No live
wallet or payment is invoked by the verification suite. The separate live
example exists for an explicitly initiated Base Sepolia testnet payment.

## Deliberate boundary

Version 0.1 supports Node 20+, exact x402 SDK and viem versions, Circle USDC on
Base Sepolia, and the exact EIP-3009 scheme. It assumes one process and one
ledger, a stable private parent directory, a correctly ordered exact signer,
trusted application code, and a trusted RPC.

It does not provide mainnet or multi-chain support, wallet custody, on-chain
enforcement, multi-writer storage, Byzantine-RPC resistance, independently
verified human approval, delivery attestation, refunds, or dispute resolution.

That narrowness is intentional: the goal is a defensible reference boundary,
not a broad security claim.

## What this shows

The artifact reduces a sourced ecosystem problem to concrete invariants, pins
those invariants with a fail-closed state machine and tests that must fail
when a protection is removed, and states what the system does not prove as
carefully as what it does. The code, tests, and design record are public;
judge the rest from them.

## Three-minute walkthrough

1. Run `npm run demo` and show two $1.80 holds with synthetic authorization
   metadata surviving a Guard reopen, then the third request being denied
   against the $5.00 cumulative budget. State explicitly that this offline demo
   does not sign or invoke x402 hooks.
2. Show the lifecycle diagram and explain why a timeout after signature remains
   committed.
3. Run the focused exposure-latch and receipt-binding regressions described in
   [examples/README.md](./examples/README.md).
4. End on the supported profile and non-goals. The credibility comes from the
   explicit boundary, not from pretending this is a universal payment firewall.

## Next credible extensions

- independently evidenced human approval;
- transactional multi-writer storage;
- another separately reviewed settlement profile;
- multi-provider or consensus-verified chain evidence;
- delivery attestation kept distinct from payment settlement.

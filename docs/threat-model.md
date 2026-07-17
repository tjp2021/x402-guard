# Threat model

## Security goal

For the supported Base Sepolia USDC exact-payment profile, the application must
not expose new payment authority when the selected x402 requirements violate
the configured mandate or when previously exposed authority cannot be safely
accounted for.

## Untrusted inputs

- seller-provided 402 requirements, including amount, payee, asset, network,
  signing metadata, resource, and extensions;
- facilitator responses and transaction hints;
- the ledger leaf file after creation;
- malformed or unexpected x402 hook payloads;
- process crashes, storage errors, RPC failures, and ambiguous network results.

## Trusted computing base

- the exact x402 signer and documented hook ordering;
- the application process and host code;
- the configured clock;
- the stable, private, single-writer ledger parent directory;
- the `LedgerStore` durability contract;
- the configured Base Sepolia RPC and `ChainReader` proof contract;
- the exact reviewed and regression-tested runtime dependency versions.

## Invariants

1. Policy denial occurs before wallet signature.
2. `ALLOW` is returned only after the hold has been appended and fsynced.
3. Settled spend and unresolved holds both consume budget.
4. A signing-gap hold blocks another signing attempt.
5. Facilitator success cannot independently mark a payment settled.
6. Under the trusted-RPC assumption, an attached authorization is released only
   after finalized evidence that its nonce is unused and chain time is strictly
   beyond `validBefore`.
7. Unreadable or economically mismatched signed payloads durably block all new
   authority.
8. Corrupt or unsupported evidence fails closed rather than being skipped.

## Explicit non-goals

Version 0.1 does not provide:

- mainnet or multi-chain support;
- wallet custody or on-chain enforcement;
- Byzantine-RPC resistance;
- multi-process ledger locking;
- proof that a human approved a payment;
- delivery or response attestation;
- chargebacks, refunds, or dispute resolution;
- protection against application code that bypasses or replaces the guard.

Use wallet or on-chain spend permissions when an agent must be technically
unable to bypass its own application policy.

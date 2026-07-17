# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Candidate version: `0.1.0`.

### Added

- Stateful x402 spending policy with per-payment, rolling-budget, velocity, and
  caller-attested approval controls.
- Durable append-before-allow authorization holds and strict versioned JSONL
  evidence.
- Exact EIP-3009 integration for Circle USDC on Base Sepolia.
- Finalized-chain settlement and expired-unused authorization reconciliation.
- Fail-closed latches for unresolved signing handoffs and unreadable signed
  payloads.

### Security

- Pin the reviewed and regression-tested x402 SDK and viem versions.
- Reject Permit2, server extensions, unknown signing metadata, mutable hook
  inputs, malformed payload envelopes, and recovered-payload bypasses.
- Require exact receipt-local `AuthorizationUsed` and matching USDC `Transfer`
  evidence before recording settlement.
- Remove every proof-free release path for ambiguous authorization outcomes.

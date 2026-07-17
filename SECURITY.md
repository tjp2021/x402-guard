# Security Policy

## Supported versions

No version has been published yet. Security reports against the current `0.1.0`
candidate are welcome. The candidate is limited to exact EIP-3009 with Circle
USDC on Base Sepolia; it is not a mainnet release.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/tjp2021/x402-guard/security/advisories/new).
Do not open a public issue for a suspected vulnerability and do not include
wallet keys, RPC credentials, ledger contents, or other secrets in a report.

Include the affected version, a minimal reproduction, the expected security
invariant, and the observed result. You should receive an acknowledgement within
three business days. Remediation timing depends on severity and reproducibility.

## Security boundary

The exact x402 signer and hook ordering, the configured clock, ledger store, and
chain reader, the stable single-writer ledger parent, and the trusted Base
Sepolia RPC are part of the trusted computing base. The library cannot stop
same-host code from bypassing or replacing it, and it does not provide
Byzantine-RPC resistance, wallet custody, delivery attestation, or independent
proof of human approval. See [README.md](./README.md) and
[design decisions](https://github.com/tjp2021/x402-guard/blob/main/docs/design-decisions.md)
for the complete boundary.

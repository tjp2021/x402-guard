# Release Candidate Manifest

## x402-guard 0.1.0

- Package-content commit: `974d3191d6441e3b48fb4a657276d3638adeb78e`
- Artifact: `x402-guard-0.1.0.tgz`
- Packed files: 36
- Packed size: 57,563 bytes
- Unpacked size: 215,837 bytes
- SHA-1 (npm shasum): `6a9275145319c877facb9f3afe2a3cc06a12bb22`
- SHA-256: `2c6d27e790f88e57ab06d26d755421a8e199f91f20dc981b7df4f000e26fda02`
- SHA-512: `fedfcec202d5248f8cc7bf9a255636c8b3893cdc84758b3aec70285e319aceb476a7e0aa3a712555ec0ebc21b279c93d2cf663286e98410fa4365b1aa3ecbdb4`
- npm integrity: `sha512-/t/OwgLVJI+Mx7+aJVY2yLOJPNyEdYs67HAoXjGazrR2p+CqOnElVewOvCGyeck9LPZjKG6YQQ+kNlsao+y9tA==`

## Verification

- Node/npm clean install: passed with the committed lockfile.
- TypeScript project and standalone demo/script checks: passed.
- Tests: 13 files, 205 tests passed on Vitest 4.1.10.
- Build: passed from a clean `dist/` directory.
- Full and production npm audits: zero known vulnerabilities.
- Git-history and extracted-tarball gitleaks scans: passed with redacted output.
- Clean-room tarball install, ESM import, and declaration typecheck: passed.
- Reproducibility: two independent packs plus the clean-commit pack produced the
  same SHA-256 digest.
- Mutation checks: receipt binding, held-state locking, ambiguity
  irreversibility, Permit2 rejection, recovery termination, and signed-payload
  freezing each made its exact regression fail when deliberately removed.
- npm name check: `x402-guard` returned `E404` before preparation.

The tarball excludes `.env` files, ledgers, plans, tests, release working notes,
and the implementation `src/` directory. Publication, Git push, and tagging are
pending separate explicit approvals.

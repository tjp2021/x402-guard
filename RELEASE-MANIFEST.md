# Release Candidate Manifest

## x402-guard 0.1.0

- Package-content commit: `6451260c5935e6047b3f9b6023f236aa89598600`
- Artifact: `x402-guard-0.1.0.tgz`
- Packed files: 36
- Packed size: 57,197 bytes
- Unpacked size: 214,474 bytes
- SHA-1 (npm shasum): `3285d1abc7d9dd17d44e61025acf71b55f72deef`
- SHA-256: `b563c72bfc61fce44569834c21d3c986e1c1e1763430f6d8c53accf42212604f`
- SHA-512: `cd275ed0a5fc2095ea9a7c6cd1b8612cc7fadf5f4b7e378743cd99f717dd5d3afda66d647045a018cb8a2fa6b8756abf37cfe9f72c3adee78342d2044211f0bb`
- npm integrity: `sha512-zSde0KX8IJXqmnxs0bhhLMf6319LfjeHQ82Z9xfdXTr9pm1kcEWgGMuKL6a4dWq/N8/p9yw63ueDQtIEQhHwuw==`

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

# Release Candidate Manifest

## x402-guard 0.1.0

- Package-content commit: `85c29d8f8bd8cee616fb332a57faf46ccd91f29f`
- Artifact: `x402-guard-0.1.0.tgz`
- Packed files: 36
- Packed size: 57,595 bytes
- Unpacked size: 215,917 bytes
- SHA-1 (npm shasum): `6ba1cb61358f4f3101f246728c1b5f4d69797006`
- SHA-256: `13ffc13bb0309d8af278d1578475047d3c4156815753952e3f893ea9d13f678a`
- SHA-512: `715245da22872f62c04dddd1cb58e4615ae8c26421cf58db1551b12671ae23eaf2759693efeef68a8f939e135be669f4fa22a3b32eb994091518d49548517054`
- npm integrity: `sha512-cVJF2iKHL2LATd3Ry1jkYVrowmQhz1jbFVGxJnGuI+rydZaT7+72io+TnhNb5mn0+iKjsy65lAkVGNSVSFFwVA==`

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

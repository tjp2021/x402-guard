# Releasing

Distribution is a GitHub release with the verified tarball attached. This
project is deliberately NOT published to the npm registry (decided 2026-07-17):
a testnet-only reference implementation gains nothing from a registry listing,
and a registry package implies a maintenance commitment this project does not
make. Do not `npm publish` without a new, explicit maintainer decision.

Publishing is a separate, explicitly approved action. Preparing or reviewing a
release candidate does not authorize a GitHub release, a Git tag, or a Git push.

## Prepare the candidate

1. Start from a clean checkout of the intended commit. Use the system npm
   (11.x); npm 10.x produces a byte-different tarball from the same commit and
   will not match recorded digests.
2. Run `npm ci` with the committed lockfile.
3. Run `npm run verify` and `npm audit --omit=dev`.
4. Run `gitleaks git --redact .` against history.
5. Build one candidate with `npm pack --pack-destination <empty-directory>`.
6. Extract that exact `.tgz`, run `gitleaks dir --redact <extracted-directory>`,
   and inspect its file list. It must not contain the implementation `src/`
   directory, tests, `.env` files, plans, ledgers, or release working notes.
7. Install the exact tarball into an empty temporary project and verify its ESM
   import and public declarations.
8. Record the commit, filename, size, SHA-256, SHA-512, tests, audit result, and
   secret-scan result in the release manifest under `docs/releases/`.

## Publish only after approval

Obtain explicit approval naming the exact tarball digest. Then:

1. Create an annotated tag `vX.Y.Z` and push it with separate Git approval.
2. Create the GitHub release from that tag, attaching the exact verified
   tarball by path; do not rebuild it.
3. Append an execution record to the release manifest.

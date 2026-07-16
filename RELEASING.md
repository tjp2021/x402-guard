# Releasing

Publishing is a separate, explicitly approved action. Preparing or reviewing a
release candidate does not authorize `npm publish`, a Git tag, or a Git push.

## Prepare the candidate

1. Start from a clean checkout of the intended commit on Node 20 or 22.
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
   secret-scan result in the release manifest.

## Publish only after approval

Obtain explicit approval naming the exact tarball digest. Publish that reviewed
file by path; do not rebuild it. Verify the registry version and integrity, then
create and push the matching signed tag only with separate Git approval.

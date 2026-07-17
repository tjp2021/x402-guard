# x402-guard

A stateful spending guard for x402 agents: cumulative budgets, durable
authorization holds, and proof-bearing settlement recovery.

[![ci](https://github.com/tjp2021/x402-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/tjp2021/x402-guard/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)

> Version 0.1 is pre-1.0, testnet-only, and deliberately limited to the `exact`
> EIP-3009 scheme with Circle USDC on Base Sepolia.

## Why it exists

An x402 pre-payment hook sees one quote at a time. It can reject a single $6
payment, but it cannot see three individually valid $2 payments crossing a $5
session budget. `x402-guard` adds that missing cumulative state and reserves
budget before a payload is signed.

The difficult part is recovery. A signed EIP-3009 authorization may still settle
after a timeout or facilitator error. This library therefore keeps ambiguous
holds committed. Once signed authority has been attached, it releases that hold
only when a trusted Base Sepolia RPC reports finalized USDC state with the nonce
unused and chain time strictly past `validBefore`. Before attachment, local state
cannot prove that signing did not race or already occur, so v0.1 exposes no
proof-free release method, keeps the hold committed, and blocks another payment
from entering the signing gap at the same time.

## Install

```sh
npm install x402-guard
```

Before registry publication, install from a source checkout instead:

```sh
git clone https://github.com/tjp2021/x402-guard
cd x402-guard
npm ci
npm run build
```

Node 20 or newer is required.

## Supported profile

| Component | Version 0.1 support |
|---|---|
| Node.js | 20 or newer |
| `@x402/core`, `@x402/evm`, `@x402/fetch` | Exactly 2.18.0 |
| viem | Exactly 2.55.2 |
| Network | Base Sepolia (`eip155:84532`) |
| Asset | Circle USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) |
| Payment scheme | `exact`, EIP-3009 only |

The exact dependency versions are part of the audited v0.1 boundary, not merely
installation preferences.

## Safety boundary

Version 0.1 provides:

- an immutable, hash-coupled policy loaded from YAML/JSON;
- per-payment caps, allowlisted payees, rolling budgets, velocity limits, and a
  caller-attested approval tier;
- serialized evaluate-and-hold, with append + fsync before an ALLOW is returned;
- one in-flight signing gap at a time: a durable `held` event blocks every later
  authorization until an exact authorization or generic exact-signer outcome is
  durably recorded;
- pre-sign requirements pinned to the USDC EIP-712 domain (`USDC`, version `2`),
  EIP-3009 transfer selection (absent or `eip3009`, never Permit2), and a positive
  safe-integer timeout of at most one hour;
- exact Base Sepolia chain identity, finalized-block support, nonempty contract
  code at the pinned USDC address, `authorizationState`, nonce, receipt, and
  Transfer verification;
- unresolved holds that never age out of budget, while verified spend ages from
  its chain-derived settlement time;
- an irreversible authority-exposure latch: an unreadable or economically
  mismatched signed payload blocks every later authorization, including after
  reopen;
- a strict versioned JSONL ledger containing resource hashes and bounded reason
  codes rather than raw URLs, errors, or notes;
- immutable verdicts, events, and history snapshots.

It does not provide:

- a wallet, facilitator, payment protocol, hosted service, or mainnet path;
- hard enforcement against a process that can rewrite its own host code;
- independent proof that a human approved a payment—`attestCallerApproval`
  records only an in-process caller assertion;
- multi-process locking. One process owns one ledger in a trusted, stable parent
  directory on POSIX; the leaf file is treated as adversarial;
- Byzantine-RPC resistance. The configured RPC provider is trusted to report the
  canonical finalized Base Sepolia chain; identity/finality/code checks catch
  misconfiguration and ordinary failure, not a provider fabricating chain data;
- delivery or response attestation. It proves spending-policy and settlement
  facts, not that the purchased resource was correct.

Pair it with wallet/on-chain spend permissions when the agent must be unable to
bypass its own limits.

The trusted computing base is explicit: the exact-scheme signer and hook
lifecycle must create at most one authorization per before-hook attempt and bind
its scheme, network, asset, value, and payee exactly to the selected
requirements. Unknown signer metadata, Permit2, and longer authorization windows
are rejected before a hold. `LedgerStore` must durably append before resolving;
`ChainReader` must faithfully derive its terminal results from the configured
chain; and `Clock` must provide trustworthy policy and budget time. The included
JSONL and viem adapters implement those contracts under the single-writer and
trusted-RPC assumptions above. A custom implementation of those ports becomes
part of the security boundary; TypeScript cannot prove its I/O behavior. Runtime
versions of the x402 SDK and viem are pinned because the v0.1 safety analysis
depends on their exact hook order, payload shape, signing route, and RPC behavior.

## Policy

```yaml
policy: research-agent-daily
version: 1
asset:
  symbol: USDC
  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
  network: eip155:84532
  decimals: 6
mandate:
  holder: research-team
  agent: research-agent-01
  expires: 2030-12-31T00:00:00Z
payees:
  allow:
    - name: Search Provider
      address: "0xE5f6070809A0b1C2d3E4f5061728394A5b6C7788"
payments:
  max_per_payment: "2.00"
  require_approval_over: "0.50"
budgets:
  - name: daily-cap
    window: rolling-24h
    limit: "5.00"
velocity:
  max_payments_per_hour: 10
```

The loader rejects unknown keys and any rail other than the fixed Base Sepolia
USDC profile.

## Create a Guard

```ts
import {
  Guard,
  JsonlLedgerStore,
  ViemChainReader,
  loadPolicyFile,
} from "x402-guard";

const loadedPolicy = await loadPolicyFile("./policy.yaml", Date.now());
const rpcUrl = process.env["BASE_SEPOLIA_RPC_URL"];
const ledgerPath = process.env["X402_GUARD_LEDGER_PATH"];
if (!rpcUrl) throw new Error("set a trusted BASE_SEPOLIA_RPC_URL");
if (!ledgerPath) throw new Error("set X402_GUARD_LEDGER_PATH outside the repository");

const guard = await Guard.open({
  loadedPolicy,
  store: new JsonlLedgerStore(ledgerPath),
  chain: new ViemChainReader({ rpcUrl }),
  clock: { now: () => Date.now() },
});
```

The RPC is required in the recommended setup because terminal settlement and
release decisions trust its finalized Base Sepolia view. Keep the ledger and
its parent directory private and outside the source checkout.

## Choose one payment integration

Use exactly one integration path for a payment attempt. Do not call
`guard.authorize` yourself for a payment that also passes through the x402
hooks—the before hook already creates the durable hold.

### Option A: x402 hooks (recommended)

The adapter reserves budget, binds the signed authorization, and routes x402
responses through chain reconciliation:

```ts
import { x402GuardHooks } from "x402-guard";

const hooks = x402GuardHooks(guard);

// Register these before every other manual after/failure hook.
client
  .onAfterPaymentCreation(hooks.onAfterPaymentCreation)
  .onPaymentCreationFailure(hooks.onPaymentCreationFailure)
  .onPaymentResponse(hooks.onPaymentResponse);

// Register any other manual before hooks above this line. The Guard must be
// the final manual before hook so nothing can alter signer inputs afterward.
client.onBeforePaymentCreation(hooks.onBeforePaymentCreation);
```

The Guard must be the final manual before-creation hook and the first manual
after-creation and creation-failure hook. Do not install a recovery hook before
it. Server-declared payment extensions are rejected, and the supported exact
signer creates at most one EIP-3009 authorization per before-hook attempt.

See [DEMO.md](./DEMO.md) and [demo/live-payment.ts](./demo/live-payment.ts) for a
complete client setup.

### Option B: direct Guard API

Use this only when your own integration owns the signing lifecycle and will
durably attach the resulting authorization. The quote amount is atomic USDC:

```ts
const quote = {
  amount: 1_000_000n,
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  network: "eip155:84532",
  payTo: "0xE5f6070809A0b1C2d3E4f5061728394A5b6C7788",
  resource: "https://seller.example/report",
} as const;

let authorization = await guard.authorize(quote);

if (authorization.decision === "require_approval") {
  // Stop here. An operator or external control must make the real decision.
  // Never call this merely because the Guard asked for approval.
  const externalDecisionWasApproved = false; // replace with your trusted workflow
  if (!externalDecisionWasApproved) throw new Error("payment not approved");
  await guard.attestCallerApproval(quote);
  authorization = await guard.authorize(quote);
}
```

An ALLOW includes a durable `holdId`; it is not permission to skip authorization
attachment or reconciliation. Most users should use Option A instead of
implementing this lifecycle themselves.

## Lifecycle semantics

| Observation | Durable effect | Terminal? |
|---|---|---:|
| Policy allows a quote | `held` after fsync; global in-flight lock | No |
| Signed payload is readable | `authorization_attached` with bigint deadline | No |
| Facilitator reports success | `settlement_reported`; transaction is only a hint | No |
| Trusted RPC reports finalized nonce + exact Transfer evidence | `settled` | Yes |
| Trusted RPC reports finalized unused nonce after deadline | `released` | Yes |
| Generic creation outcome is unknown | `indeterminate`; original quote remains committed and in-flight lock clears | No |
| Signed payload is unreadable or mismatches the held economics | irreversible `indeterminate` exposure latch; all new authority stops | No |

RPC errors, wrong chain, missing logs, stale/future local clocks, and malformed
reader evidence are all nonterminal. A storage error faults the Guard; it will
refuse new authority until a clean reopen replays the durable ledger.

## Ledger and migration

`JsonlLedgerStore` creates or repairs the leaf ledger to mode `0600`, refuses
symlinks, hard links and non-regular files, verifies inode identity around I/O,
and fsyncs both data and a newly created directory entry. Records are capped at
16 KiB and the v0.1 reader envelope at 64 MiB.

Pre-v0.1 unversioned ledgers are intentionally not rewritten or guessed. Move
the old file aside for manual review and start a new v0.1 ledger. Never discard
an old ledger merely to free budget.

The ledger contains public addresses, nonces, amounts, timestamps, policy and
resource hashes, and transaction references. Those facts can still be sensitive
in aggregate; keep both the file and its parent directory private.

## Develop and verify

```sh
npm ci
npm run verify
npm pack --dry-run
```

CI uses fixtures and performs no wallet, payment, or live-network action. See
[DEMO.md](./DEMO.md) for the separately invoked Base Sepolia demonstration and
[DECISIONS.md](./DECISIONS.md) for the safety reversals behind the design.

## Security and limitations

Please report suspected vulnerabilities through GitHub's private vulnerability
reporting flow. See [SECURITY.md](./SECURITY.md) for the disclosure policy and
[CHANGELOG.md](./CHANGELOG.md) for release notes.

The project is motivated by x402's payment-integrity and delivery-attestation
work. It implements the stateful pre-payment and settlement-evidence layer; it
does not claim to implement response receipts or the entire x402 roadmap.

## License

Apache-2.0. See [LICENSE](./LICENSE).

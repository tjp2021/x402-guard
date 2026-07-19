# x402-guard

**A valid x402 payment can still violate an agent's application-loaded spending
policy. `x402-guard` denies it before the supported signer and keeps ambiguous
payments reserved after failure.**

[![ci](https://github.com/tjp2021/x402-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/tjp2021/x402-guard/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)

> **Status:** independent, pre-1.0 reference implementation. Version 0.1 is
> testnet-only and supports one regression-tested composition:
> exact EIP-3009 payments with Circle USDC on Base Sepolia. It is not an
> official x402 package or a production wallet-security product.

## The problem in 30 seconds

Suppose an application's policy gives an agent a $5.00 rolling budget. The
policy's holder field is descriptive metadata, not authenticated authority.
Three services each request $1.80:

```text
request 1: $1.80  (individually valid)
request 2: $1.80  (individually valid)
request 3: $1.80  (individually valid)
total:     $5.40  (mandate violated)
```

The x402 SDK provides per-attempt lifecycle hooks. A bare hook does not provide
durable cumulative policy, an append-before-sign hold, or recovery semantics.
`x402-guard` supplies that stateful layer for attempts handled by one Guard and
one durable ledger.

The harder case comes after signing. If an EIP-3009 payment times out, failure
does not prove that the authorization was unused. Releasing its budget and
retrying can expose more authority than the mandate permits. Keeping every
uncertain payment forever is safe but unusable.

`x402-guard` therefore enforces three invariants:

1. Evaluate recipient, rail, amount, velocity, and cumulative budget before the
   supported signer receives payment requirements.
2. With the bundled JSONL store, append and fsync a hold before `ALLOW` returns.
3. After signed authority is attached, settle or release the hold only from
   finalized Base Sepolia evidence under a trusted-RPC assumption. Unknown stays
   committed.

## Who it is for

This project is for developers building autonomous x402 buyers with their own
wallet, RPC, and application policy. It is also a reference for security and
infrastructure engineers studying payment lifecycle failures.

It is not for sellers adding an x402 paywall, applications that need mainnet or
multi-chain support, or users looking for wallet custody, delivery guarantees,
chargebacks, or a hosted service.

## Where it fits

| Layer | Responsibility |
|---|---|
| x402 client SDK | Negotiate a 402 challenge, create a payment payload, and retry the request |
| Managed agent wallet | Isolate keys and provide wallet-level controls such as per-call or session limits |
| `x402-guard` | Add vendor-neutral application policy, cumulative holds, strict evidence, and recovery to one guarded ledger |

Managed products already validate the need for agent spending controls.
`x402-guard` is not claiming to be first or universally better. Its contribution
is an inspectable, application-owned implementation with payee allowlists,
rolling budgets, velocity rules, durable authorization holds, and conservative
reconciliation.

## Install

This package is distributed through GitHub releases, not the npm registry.
Install the verified release artifact directly:

```sh
npm install https://github.com/tjp2021/x402-guard/releases/download/v0.1.0/x402-guard-0.1.0.tgz
```

The tarball's SHA-256 is recorded in
[docs/releases/v0.1.0.md](https://github.com/tjp2021/x402-guard/blob/main/docs/releases/v0.1.0.md).

For source review, the demo, or contribution, use a repository checkout:

```sh
git clone https://github.com/tjp2021/x402-guard
cd x402-guard
npm ci
npm run build
```

Then run `npm install /absolute/path/to/x402-guard` from the consuming project.

Node 20 or newer is required.

## Run the core demonstration

From a repository checkout, the default demo uses no wallet, network, secret,
or payment:

```sh
npm run demo
```

It allows two $1.80 attempts, attaches synthetic authorization metadata, opens a
new Guard from the same ledger, and denies a third attempt because the projected
$5.40 exceeds the $5.00 application policy. It does not create a wallet
signature or invoke x402 hooks.

```text
application policy: $5.00 rolling-24h; each request: $1.80

payment 1: ALLOW $1.80: synthetic authorization attached durably
payment 2: ALLOW $1.80: synthetic authorization attached durably

Guard reopen: reading the same durable ledger
recovered committed amount: $3.60 (outcome still ambiguous)
payment 3: DENY  $1.80: projected $5.40 exceeds $5.00
result: no third authorization was admitted or attached
```

The separately invoked `npx tsx examples/live-payment.ts` action spends valueless
Base Sepolia USDC and requires explicit testnet credentials. It is available
only from a repository checkout and is never run by CI or by the ordinary
verification suite. See the
[examples guide](https://github.com/tjp2021/x402-guard/blob/main/examples/README.md).

## Architecture

```text
seller's 402 challenge
          |
          v
  strict requirement validation
          |
          v
  mandate evaluation
          |
          v
  durable authorization hold
          |
          v
      wallet signature
          |
          v
     payment attempt
          |
          v
 finalized chain evidence
    |          |          |
 settled    released    unknown
                          |
                    remain committed
```

The facilitator's success response is a transaction hint, not a terminal
settlement fact. The bundled chain reader records settlement only when finalized
state contains the exact authorization and a matching USDC Transfer. It releases
only when the nonce is finalized unused and chain time is strictly later than
`validBefore`.

See the
[architecture](https://github.com/tjp2021/x402-guard/blob/main/docs/architecture.md),
[threat model](https://github.com/tjp2021/x402-guard/blob/main/docs/threat-model.md),
and [design decisions](https://github.com/tjp2021/x402-guard/blob/main/docs/design-decisions.md)
for the full reasoning.

## Supported profile

| Component | Version 0.1 support |
|---|---|
| Node.js | 20 or newer |
| `@x402/core`, `@x402/evm`, `@x402/fetch` | Exactly 2.18.0 |
| viem | Exactly 2.55.2 |
| Network | Base Sepolia (`eip155:84532`) |
| Asset | Circle USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) |
| Payment scheme | `exact`, EIP-3009 only |
| Writer model | One process owns one ledger in a trusted stable parent directory |

The exact dependency versions are part of the tested v0.1 compatibility
boundary because hook order, payload shape, signing route, and RPC behavior are
security-relevant.

## Configure a policy

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

The loader rejects unknown keys and any rail outside the fixed Base Sepolia USDC
profile.

## Connect the guard

```ts
import {
  Guard,
  JsonlLedgerStore,
  ViemChainReader,
  loadPolicyFile,
  x402GuardHooks,
} from "x402-guard";

const rpcUrl = process.env["BASE_SEPOLIA_RPC_URL"];
const ledgerPath = process.env["X402_GUARD_LEDGER_PATH"];
if (!rpcUrl) throw new Error("set a trusted BASE_SEPOLIA_RPC_URL");
if (!ledgerPath) throw new Error("set a private ledger path outside the checkout");

const guard = await Guard.open({
  loadedPolicy: await loadPolicyFile("./policy.yaml", Date.now()),
  store: new JsonlLedgerStore(ledgerPath),
  chain: new ViemChainReader({ rpcUrl }),
  clock: { now: () => Date.now() },
});

const hooks = x402GuardHooks(guard);

// Register the Guard first for every after/failure phase.
client
  .onAfterPaymentCreation(hooks.onAfterPaymentCreation)
  .onPaymentCreationFailure(hooks.onPaymentCreationFailure)
  .onPaymentResponse(hooks.onPaymentResponse);

// Register other manual before hooks above this line. The Guard must be the
// final manual before hook so later code cannot alter signer inputs.
client.onBeforePaymentCreation(hooks.onBeforePaymentCreation);
```

Use this hook path for ordinary integrations. A direct `Guard` integration must
own the entire signing lifecycle, durably attach the exact authorization, and
reconcile every nonterminal hold. See
[advanced integration](https://github.com/tjp2021/x402-guard/blob/main/docs/advanced-integration.md).

## Lifecycle

| Observation | Durable effect | Terminal? |
|---|---|---:|
| Policy allows a quote | `held` after bundled-store fsync; signing-gap lock | No |
| Signed payload is readable and matches | `authorization_attached` with bigint deadline | No |
| Facilitator reports success | `settlement_reported`; transaction remains a hint | No |
| Chain lookup begins | `reconciling` appended before any RPC call | No |
| Trusted RPC reports finalized exact nonce and Transfer evidence | `settled` | Yes |
| Trusted RPC reports finalized unused nonce after deadline | `released` | Yes |
| Generic creation outcome is unknown | `indeterminate`; original quote remains committed | No |
| Signed payload is unreadable or mismatches the hold | irreversible exposure latch; all new authority stops | No |

Storage failure faults the Guard closed. RPC errors, wrong-chain responses,
missing logs, unsupported finality, malformed evidence, and time uncertainty are
all nonterminal.

## Safety boundary

Version 0.1 includes:

- immutable, hash-coupled policy loading;
- amount, network, asset, payee, rolling-budget, velocity, and caller-attested
  approval controls;
- serialized evaluate-and-hold with append-before-allow in the bundled JSONL
  adapter;
- one in-flight signing gap at a time;
- strict validation of the declared USDC EIP-712 domain parameters and
  EIP-3009 route;
- rejection of Permit2, populated server extensions, unknown signer metadata,
  and a server-declared `maxTimeoutSeconds` above one hour;
- strict versioned evidence that excludes raw URLs, upstream errors, and
  signatures;
- an irreversible latch when observed signed authority cannot be bounded by the
  recorded hold.

The trusted computing base includes the application host, exact signer, hook
ordering, clock, ledger store, chain reader, stable ledger parent directory, and
trusted Base Sepolia RPC. The signer is assumed to create at most one
authorization for an attempt and bind its economics to the selected
requirements.

Version 0.1 does not provide:

- a wallet, facilitator, hosted service, or mainnet path;
- protection from host code that bypasses or replaces the guard;
- independent proof of human approval;
- multi-process locking or distributed storage safety;
- Byzantine-RPC resistance;
- delivery or response attestation;
- chargebacks, refunds, or merchant-performance guarantees.

Pair application policy with wallet or on-chain spend permissions when the
agent must be technically unable to bypass its own limits.

## Verification

```sh
npm run verify
npm pack --dry-run
```

`npm run verify` runs the strict TypeScript checks for the project and
examples, a clean build, the 205 deterministic tests, and the offline demo;
this is exactly what CI runs. The release process additionally ran dependency
audits, secret scans, and a clean-room package import/declaration check;
those results are recorded in
[docs/releases/v0.1.0.md](https://github.com/tjp2021/x402-guard/blob/main/docs/releases/v0.1.0.md).
Several safety branches were also spot-checked by deliberately removing the
protection and confirming the matching test fails.

These are local verification results, not an independent security audit. The
ordinary suite uses fixtures and performs no wallet, payment, or live-network
action.

For the project-level reasoning and role relevance, see the
[case study](https://github.com/tjp2021/x402-guard/blob/main/CASE-STUDY.md).

## Public problem evidence

| Source | Relevance |
|---|---|
| [x402 introduction](https://docs.x402.org/introduction) | Defines the open HTTP payment flow for clients, including agents |
| [x402 client/server lifecycle](https://docs.x402.org/core-concepts/client-server) | Shows challenge, signed payload, retry, and settlement responsibilities |
| [x402 payment-integrity proposal](https://github.com/x402-foundation/x402/issues/2823) | Documents the need to verify price, asset, network, and recipient before settlement |
| [Coinbase Agentic Wallet limits](https://docs.cdp.coinbase.com/agentic-wallet/mcp/faq) | Validates per-call and session spending controls as a product category |
| [x402 delivery-attestation proposal](https://github.com/x402-foundation/x402/issues/2833) | Separates payment evidence from proving what the seller delivered |

This is an independent implementation inspired by public ecosystem problems. It
does not represent adoption or endorsement by the linked projects.

## Contributing

Questions and issues are welcome. This is a versioned reference implementation,
not a roadmap-driven product: open an issue to discuss any change before
sending a pull request, especially anything that touches the safety boundary.

## Security and license

Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/tjp2021/x402-guard/security/advisories/new).
See [SECURITY.md](./SECURITY.md) for the disclosure policy and
[CHANGELOG.md](./CHANGELOG.md) for release notes.

Apache-2.0. See [LICENSE](./LICENSE).

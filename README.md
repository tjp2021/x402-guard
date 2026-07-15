# x402-guard

A spending policy that holds across an agent's whole session — not one
transaction at a time.

[![ci](https://github.com/tjp2021/x402-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/tjp2021/x402-guard/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)

## Contents

- [The problem](#the-problem)
- [What it does](#what-it-does) · [What it does not do](#what-it-does-not-do)
- [Threat model](#threat-model)
- [Status](#status)
- [Install](#install) · [Develop](#develop)
- [Prior art](#prior-art) · [Upstream](#upstream)
- [Contributing](#contributing) · [License](#license)

## The problem

x402 lets an AI agent pay for things over HTTP. The SDK's pre-payment hook
(`onBeforePaymentCreation`) can veto a payment — but it is **stateless**. It sees
one quote at a time, so it can enforce "no single payment over $2" and nothing
more.

That is not a budget. An agent told "$2 max per payment, $5 max per day" can
spend $2, then $2, then $2, then $2 — each payment passes the per-transaction
check, and the day's spend is $8. Split an over-budget purchase into under-limit
charges and a per-transaction limit never notices.

The failure is not hypothetical: a runaway loop, a compromised tool, or a
price-gouging server all reach the same place — money out the door that no single
check objected to.

## What it does

`x402-guard` adds the cumulative state the hook cannot hold. You write a policy;
it tracks spend across the whole session with authorization holds, and produces a
typed verdict — `allow`, `deny`, or `require_approval` — that names the clause
that decided it.

```yaml
# examples/research-agent.policy.yaml — the whole control surface, no code.
policy: research-agent-daily
version: 1
asset:
  symbol: USDC
  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"  # USDC, Base Sepolia
  network: eip155:84532
  decimals: 6
mandate:
  holder: research-team
  agent: research-agent-01
  expires: 2026-12-31T00:00:00Z
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
    limit: "5.00"          # cumulative — this is what a per-transaction cap cannot do
velocity:
  max_payments_per_hour: 10
```

> Not on npm yet — install from source ([Install](#install)). The `"x402-guard"`
> import below resolves once you've built and linked the package locally.

```ts
import { Guard, loadPolicyFile, JsonlLedgerStore, ViemChainReader } from "x402-guard";

const { policy, hash } = await loadPolicyFile("./policy.yaml", Date.now());

const guard = await Guard.open({
  policy,
  policyHash: hash,
  store: new JsonlLedgerStore("./ledger.jsonl"),
  chain: new ViemChainReader(),           // reads Base Sepolia
  clock: { now: () => Date.now() },
});

let decision = await guard.authorize(quote);     // evaluate + reserve budget, atomically

if (decision.decision === "require_approval") {  // over the approval threshold
  guard.approve(quote);                          // a human's yes, bound to this quote
  decision = await guard.authorize(quote);
}

if (decision.decision === "allow") {
  // ... pay over x402, then:
  await guard.attachAuthorization(decision.holdId, nonce, payer, validBefore);
  await guard.confirm(decision.holdId, txHash);
}
```

The agent that wants $5.40 against a $5.00 cap, split into three $1.80 charges,
gets its third payment **denied** — because the first two are remembered.

## What it does not do

- It is **not** a wallet, a payment protocol, or a facilitator. It sits beside
  the x402 client and decides.
- It is **advisory containment, not hard enforcement.** The guard runs in-process
  with the agent; an agent that can write to the host can tamper with its own
  ledger. It is a seatbelt, not a cage — pair it with on-chain spend permissions
  (Coinbase CDP / ERC-7715) for enforcement the agent cannot reach.
- **Single writer only.** One ledger file, one process. Two processes over one
  file each enforce the full cap independently and together spend twice.
- **Testnet.** The chain reader targets Base Sepolia. No mainnet path exists in
  the code.

## Threat model

The pieces this is built to withstand, and where its edges are:

- **The x402 server is untrusted.** A hostile server quoting 100x the price is
  denied by the per-payment cap; the quote's asset and network are pinned, so a
  quote in a different token or on mainnet is denied outright.
- **The quote is untrusted.** A negative amount cannot mint budget; a malformed
  address cannot defeat the allowlist. Both are denied at the boundary.
- **The facilitator is untrusted for evidence — in reconciliation.** When a hold
  goes quiet, reconciliation reads settlement from the chain, not the
  facilitator's index (the answer to payments that settle but never get indexed).
  On the happy path, though, the adapter confirms a hold from the facilitator's
  success response without an inline chain check. That is fail-safe — a false
  success keeps the budget committed, it never frees it — but such a `settled`
  entry is not independently verified until reconciliation or `npm run
  verify:live` runs against it. The `verifyTransfer` that does the verifying is
  the same code either path uses; wiring it inline on every settlement is a small
  extension, not a redesign. Stated plainly so the claim is not oversold.
- **A signed authorization is a bearer instrument.** It is not released until it
  can no longer be submitted (`validBefore`), and a hold whose payload may have
  been signed is never auto-released.
- **The agent is untrusted with respect to policy.** Policy is enforced outside
  the agent; an agent cannot talk the gate into a larger limit. But see "advisory
  containment" above — this is the boundary, stated plainly.

## Status

What exists and is tested:

- the stateful policy engine, authorization holds, and typed verdicts;
- the on-chain reconciliation logic targeting Base Sepolia (settlement matched
  to the exact authorization, not merely "a payment happened");
- a durable append-only ledger with crash recovery;
- **the x402 adapter** — `x402GuardHooks(guard)` wires the guard into
  `@x402/core`'s real payment hooks (`onBeforePaymentCreation`,
  `onAfterPaymentCreation`, `onPaymentResponse`, `onPaymentCreationFailure`).
  Verified against the installed `@x402/core`/`@x402/evm` types and
  integration-tested through the full hook lifecycle, including the
  split-purchase attack caught through the actual hooks;
- 124 tests. The safety-critical ones are mutation-checked by hand — the test is
  confirmed to fail when the code it guards is deliberately broken, because a
  test that cannot fail is not a test.

**Demonstrated end to end on Base Sepolia.** `npm run demo` stands up a local
x402 server and pays it through the guard; the payment settles on-chain, and a
second payment to a seller the policy does not allow is blocked before signing —
no money moves. A real run:

- allowed payment settled:
  [`0x82ba06be…`](https://sepolia.basescan.org/tx/0x82ba06be4ad379fc4f61e14533b4812bfff366060e9c63368dc435a1249a5ce2)
  — 0.01 USDC moved from payer to the configured payee. (The demo pays the burn
  address `0x…dEaD`, so it's a real on-chain USDC settlement with no counterparty
  to fund — anyone can reproduce it.)
- non-allowlisted payment: **denied by the guard, 0 USDC moved.**

See [DEMO.md](./DEMO.md) to reproduce. The chain reader is exercised against
fakes in the test suite (no live RPC in CI). `npm run verify:live` runs the real
`ViemChainReader` against that settlement on Base Sepolia and confirms it
reconciles — matching the `AuthorizationUsed` log for the nonce to the paired
`Transfer`'s sender, recipient, and amount — so the on-chain path is checked on
real data, not only fakes.

## Prior art

- [`presidio-hardened-x402`](https://github.com/presidio-v/presidio-hardened-x402)
  — the closest neighbor: declarative spend policy for x402 in Python, with
  daily limits and Redis state. x402-guard differs in being TypeScript-native
  (x402's own SDK ecosystem), returning a typed verdict that names the deciding
  clause rather than a pass/raise, and treating approval as a first-class verdict.
- **Coinbase CDP Spend Permissions / ERC-7715 / Circle Agent Wallets** enforce
  per-period allowances at the wallet, on-chain. Those are the hard-enforcement
  layer this pairs with; this is the portable, self-hosted policy-and-evidence
  layer above them.

## Upstream

Two open items on the x402 tracker motivate this work:

- [x402#2823](https://github.com/x402-foundation/x402/issues/2823) — a
  payment-integrity verifier that runs before settlement. This is what the gate
  is: policy checked before money moves, and settlement matched to the exact
  authorization afterward.
- [x402#2833](https://github.com/x402-foundation/x402/issues/2833) — delivery /
  receipt attestation binding a payment to its request and response. This library
  does **not** implement that (it does not fingerprint or sign responses); the
  reconciliation and verdict trail here are a substrate a receipt could build on.

## Install

Not published to npm yet. Install from source:

```sh
git clone https://github.com/tjp2021/x402-guard
cd x402-guard
npm ci
npm run build
```

Requires Node ≥ 20. To use it from another local project, `npm link` it (or
import directly from `dist/` after building).

## Develop

```sh
npm ci
npm test          # 124 tests
npm run typecheck  # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
npm run build      # emit dist/
```

Node ≥ 20. See [DECISIONS.md](./DECISIONS.md) for the design calls and the ones
that were reversed.

## Contributing

Issues and PRs welcome. Run `npm test && npm run typecheck` before opening a PR.
Two house rules, both from hard-won experience (see [DECISIONS.md](./DECISIONS.md)):
new behavior needs a test that fails without it, and any safety-critical path is
mutation-checked — the test is confirmed to go red when the code it guards is
deliberately broken.

## License

Apache-2.0.

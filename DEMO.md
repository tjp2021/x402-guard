# Running a live payment through the guard

This wires the guard into a real `@x402/fetch` client and makes a real payment on
Base Sepolia testnet. Every API call below is against the installed `@x402/core`,
`@x402/evm`, and `@x402/fetch` (v2.18). The adapter is typechecked against those
hook contracts and its lifecycle is fixture-tested. What this file cannot do for
you is fund a wallet; that is the one manual step, described at the end.

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { wrapFetchWithPayment } from "@x402/fetch";

import {
  Guard,
  loadPolicyFile,
  JsonlLedgerStore,
  ViemChainReader,
  x402GuardHooks,
} from "x402-guard";

// 1. A testnet wallet. Generate one, or load from an env var. Never a mainnet key.
const key = process.env["X402_TESTNET_KEY"];
if (!key) throw new Error("set X402_TESTNET_KEY to a testnet-only key");
const account = privateKeyToAccount(key as `0x${string}`);
console.log("fund this address with Base Sepolia USDC:", account.address);

const rpcUrl = process.env["BASE_SEPOLIA_RPC_URL"];
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
});
const signer = toClientEvmSigner(account, publicClient);

// 2. The guard, from the policy file, backed by a durable ledger and the chain.
const loadedPolicy = await loadPolicyFile(
  "./examples/research-agent.policy.yaml",
  Date.now(),
);
const chain = rpcUrl
  ? new ViemChainReader({ rpcUrl })
  : new ViemChainReader();
const guard = await Guard.open({
  loadedPolicy,
  store: new JsonlLedgerStore("./demo/ledger.jsonl"), // ignored by this repository
  chain,
  clock: { now: () => Date.now() },
});

// 3. The x402 client, with the exact/EIP-3009 scheme and the guard's hooks.
const hooks = x402GuardHooks(guard);
const client = x402Client
  .fromConfig({ schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(signer) }] })
  .onBeforePaymentCreation(hooks.onBeforePaymentCreation)
  .onAfterPaymentCreation(hooks.onAfterPaymentCreation)
  .onPaymentResponse(hooks.onPaymentResponse)
  .onPaymentCreationFailure(hooks.onPaymentCreationFailure);

// The before hook accepts only Circle USDC's USDC/2 EIP-712 domain, EIP-3009,
// and a positive authorization timeout no longer than one hour.

// 4. Pay. The guard evaluates before signing, reserves budget, captures the
//    authorization, and verifies settlement — all through the hooks.
const fetchWithPay = wrapFetchWithPayment(fetch, client);
const res = await fetchWithPay("https://an-x402-endpoint.example/paid-resource");

console.log("status:", res.status);
console.log("ledger:", guard.history());   // the audit trail, one line per state change
```

The response hook does not trust facilitator success as settlement evidence. It
records the transaction as a nonterminal hint, then asks the trusted Base
Sepolia RPC for finalized USDC state, the exact nonce, and Transfer. A newly
mined transaction may not yet be finalized, so the repository's
[`demo/live-payment.ts`](https://github.com/tjp2021/x402-guard/blob/main/demo/live-payment.ts)
polls the same reconciliation path for up to one minute.

If creation fails before the authorization can be read and durably attached, the
hold remains committed. Version 0.1 intentionally has no caller-only unsigned
release: the guard cannot prove that signing did not already occur or race the
failure callback. If an after-creation payload is unreadable or does not match
the held amount and recipient, the durable exposure latch blocks every new
authorization across restart; already-known holds can still reconcile. While a
normal `held` payment is between before- and after-creation hooks, it likewise
blocks a second signing flight instead of relying on a timeout to guess that the
first signer stopped.

## The one manual step

To make step 4 actually settle on-chain you need two things this repo cannot
provide for you:

1. **Base Sepolia USDC in the wallet.** Print the address (step 1 does), then
   fund it from the [Circle faucet](https://faucet.circle.com) (select Base
   Sepolia). Transfers are gasless — the facilitator sponsors gas — so no
   testnet ETH is needed.
2. **A payable x402 endpoint on Base Sepolia** to point step 4 at. Any x402
   resource server that accepts the exact/EIP-3009 scheme on `eip155:84532`
   works; you can also stand one up locally with `@x402/express`.

Running the demo is an explicit live testnet action: it reads the configured
testnet key and transfers valueless testnet USDC. It is never run by CI or the
ordinary test suite.

The live script makes one allowed `$0.01` payment and then proves that a payment
to a non-allowlisted seller is rejected before signing with no USDC movement.
The deterministic suite separately proves that the third `$1.80` charge crosses
the example policy's `$5.00` cumulative cap and is denied.

If this checkout has a pre-v0.1 `ledger.jsonl`, move it aside for manual review
before the demo. The hardened reader intentionally rejects legacy unversioned
records; it never silently migrates or discards payment evidence.

## What is proven without the manual step

The adapter's installed x402 hook types and lifecycle contract are tested in
`test/x402-adapter.test.ts` with deterministic structural contexts. The tests
catch split purchases, preserve `validBefore` as bigint seconds, reject
unsupported rails and malformed challenges, keep ambiguous creation failures
committed, and treat facilitator success as nonterminal until reader evidence
arrives. The separately invoked live script is the end-to-end x402Client test.

`test/viem-chain.test.ts` exercises wrong-chain, missing-finality, missing-code,
clock-skew, log/receipt, and exact Transfer cases with deterministic clients. The
optional `npm run verify:live` command runs the real reader against the public
Base Sepolia settlement cited by this repository; it is not part of CI.

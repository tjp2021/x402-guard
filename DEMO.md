# Running a live payment through the guard

This wires the guard into a real `@x402/fetch` client and makes a real payment on
Base Sepolia testnet. Every API call below is against the installed `@x402/core`,
`@x402/evm`, and `@x402/fetch` (v2.18) — the adapter is typechecked and
integration-tested against these types. What this file cannot do for you is fund
a wallet; that is the one manual step, described at the end.

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { x402Client } from "@x402/core/client";
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
const account = privateKeyToAccount(process.env.X402_TESTNET_KEY as `0x${string}`);
console.log("fund this address with Base Sepolia USDC:", account.address);

const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);

// 2. The guard, from the policy file, backed by a durable ledger and the chain.
const { policy, hash } = await loadPolicyFile("./examples/research-agent.policy.yaml", Date.now());
const guard = await Guard.open({
  policy,
  policyHash: hash,
  store: new JsonlLedgerStore("./ledger.jsonl"),
  chain: new ViemChainReader(),
  clock: { now: () => Date.now() },
});

// 3. The x402 client, with the exact/EIP-3009 scheme and the guard's hooks.
const hooks = x402GuardHooks(guard);
const client = new x402Client({ schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(signer) }] })
  .onBeforePaymentCreation(hooks.onBeforePaymentCreation)
  .onAfterPaymentCreation(hooks.onAfterPaymentCreation)
  .onPaymentResponse(hooks.onPaymentResponse)
  .onPaymentCreationFailure(hooks.onPaymentCreationFailure);

// 4. Pay. The guard evaluates before signing, reserves budget, captures the
//    authorization, and records the settlement — all through the hooks.
const fetchWithPay = wrapFetchWithPayment(fetch, client);
const res = await fetchWithPay("https://an-x402-endpoint.example/paid-resource");

console.log("status:", res.status);
console.log("ledger:", guard.history());   // the audit trail, one line per state change
```

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

With those in place, the third `$1.80` payment against the example policy's
`$5.00` daily cap is denied by the guard — before the SDK ever signs it — and the
first two settle with inspectable transaction hashes in `guard.history()`.

## What is proven without the manual step

The adapter is integration-tested (`test/x402-adapter.test.ts`) by driving the
full `before → after → response` hook lifecycle with the exact context shapes the
SDK produces: the split-purchase attack is caught through the hooks, the
settlement and `validBefore` are recorded, an unsupported scheme is denied, and a
signing failure abandons the hold. The wiring above is the same wiring those
tests exercise — the funded wallet only changes the fakes into a live chain.

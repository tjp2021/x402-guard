/**
 * A real x402 payment on Base Sepolia, guarded.
 *
 * Self-contained: it stands up a local x402 resource server, then pays it with a
 * guard-wrapped client. The payment settles on-chain through the public
 * facilitator, so it produces a real, inspectable transaction hash.
 *
 * Run:  X402_TESTNET_KEY must be a funded Base Sepolia key (see DEMO.md).
 *       npm run demo
 *
 * Everything money-related is testnet. There is no mainnet path.
 */

import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, erc20Abi } from "viem";
import { baseSepolia } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { wrapFetchWithPayment } from "@x402/fetch";

import {
  Guard,
  JsonlLedgerStore,
  ViemChainReader,
  loadPolicy,
  x402GuardHooks,
} from "../src/index.js";

const NETWORK = "eip155:84532" as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FACILITATOR = "https://x402.org/facilitator";
const PORT = 4021;

async function main() {
  const key = process.env["X402_TESTNET_KEY"];
  if (!key) throw new Error("set X402_TESTNET_KEY in .env (a funded Base Sepolia key)");

  const account = privateKeyToAccount(key as `0x${string}`);
  const rpcUrl = process.env["BASE_SEPOLIA_RPC_URL"];
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  // Refuse to run on an empty wallet — the whole point is a real settlement.
  const balance = (await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
  })) as bigint;
  console.log(`payer ${account.address} — USDC balance ${balance}`);
  if (balance === 0n) throw new Error(`fund ${account.address} with Base Sepolia USDC (faucet.circle.com)`);

  // The seller receives the payment. A second throwaway testnet address.
  const receiver = "0x000000000000000000000000000000000000dEaD"; // burn addr; real USDC moves here

  // --- local x402 server: GET /paid costs 0.01 USDC ------------------------
  const app = express();
  app.use(paymentMiddlewareFromConfig(
    { "GET /paid": { accepts: { scheme: "exact", payTo: receiver, price: "$0.01", network: NETWORK } } },
    new HTTPFacilitatorClient({ url: FACILITATOR }),
    [{ network: NETWORK, server: new ExactEvmServerScheme() }],
  ));
  app.get("/paid", (_req, res) => res.json({ ok: true, secret: "the paid resource" }));

  // A second route whose seller is NOT on the policy allowlist. The guard should
  // refuse to pay it — before signing, so no money can move.
  const stranger = "0x00000000000000000000000000000000BeefBeef";
  const app2 = express();
  app2.use(paymentMiddlewareFromConfig(
    { "GET /paid": { accepts: { scheme: "exact", payTo: stranger, price: "$0.01", network: NETWORK } } },
    new HTTPFacilitatorClient({ url: FACILITATOR }),
    [{ network: NETWORK, server: new ExactEvmServerScheme() }],
  ));
  app2.get("/paid", (_req, res) => res.json({ ok: true, secret: "should never be reached" }));
  const strangerServer = createServer(app2);
  await new Promise<void>((r) => strangerServer.listen(PORT + 1, r));

  const server = createServer(app);
  await new Promise<void>((r) => server.listen(PORT, r));

  // --- the guard, allowlisting the receiver --------------------------------
  const now = Date.now();
  const loadedPolicy = loadPolicy({
    policy: "demo", version: 1,
    asset: { symbol: "USDC", address: USDC, network: NETWORK, decimals: 6 },
    mandate: { holder: "demo", agent: "demo-agent", expires: new Date(now + 3600_000).toISOString() },
    payees: { allow: [{ name: "demo-seller", address: receiver }] },
    payments: { max_per_payment: "1.00", require_approval_over: "1.00" },
    budgets: [{ name: "daily", window: "rolling-24h", limit: "1.00" }],
    velocity: { max_payments_per_hour: 10 },
  }, now);

  const guard = await Guard.open({
    loadedPolicy,
    store: new JsonlLedgerStore("./demo/ledger.jsonl"),
    chain: rpcUrl ? new ViemChainReader({ rpcUrl }) : new ViemChainReader(),
    clock: { now: () => Date.now() },
  });

  // --- the guarded client --------------------------------------------------
  const signer = toClientEvmSigner(account, publicClient);
  const hooks = x402GuardHooks(guard);
  let observedPayeeDenial = false;
  const observedBeforeHook: typeof hooks.onBeforePaymentCreation = async (ctx) => {
    const result = await hooks.onBeforePaymentCreation(ctx);
    if (
      result?.abort === true &&
      result.reason === "x402-guard: policy payee_not_allowed"
    ) {
      observedPayeeDenial = true;
    }
    return result;
  };
  const client = x402Client
    .fromConfig({ schemes: [{ network: NETWORK, client: new ExactEvmScheme(signer) }] })
    .onBeforePaymentCreation(observedBeforeHook)
    .onAfterPaymentCreation(hooks.onAfterPaymentCreation)
    .onPaymentResponse(hooks.onPaymentResponse)
    .onPaymentCreationFailure(hooks.onPaymentCreationFailure);

  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  console.log("\n--- paying GET /paid ($0.01) ---");
  const paymentHistoryStart = guard.history().length;
  const res = await fetchWithPay(`http://localhost:${PORT}/paid`);
  console.log("status:", res.status, await res.text());
  if (res.status !== 200) throw new Error("guarded payment did not return 200");
  const currentHold = guard.history().slice(paymentHistoryStart)
    .find((entry) => entry.status === "held");
  if (!currentHold) throw new Error("current payment did not create a durable hold");

  // A facilitator success is only a hint. The response hook immediately checks
  // finalized chain state, which may legitimately lag the just-mined payment.
  // Poll the durable proof path for at most one minute; never manufacture a
  // settlement from the response itself.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (
      guard.history().slice(paymentHistoryStart)
        .some(
          (entry) =>
            entry.holdId === currentHold.holdId && entry.status === "settled",
        )
    ) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await guard.reconcile();
  }

  console.log("\n--- ledger (the audit trail) ---");
  for (const e of guard.history()) {
    const transaction = e.status === "settled" ? `  tx=${e.transaction}` : "";
    console.log(`  ${e.status.padEnd(22)} ${e.holdId}${transaction}`);
  }
  const settled = guard.history().slice(paymentHistoryStart)
    .find(
      (entry) =>
        entry.holdId === currentHold.holdId && entry.status === "settled",
    );
  if (!settled || settled.status !== "settled") {
    throw new Error("current payment did not reach finalized settlement");
  }
  console.log(`\n✓ settled on-chain: https://sepolia.basescan.org/tx/${settled.transaction}`);

  // --- now try to pay a seller the policy does not allow --------------------
  console.log("\n--- attempting to pay a NON-allowlisted seller ($0.01) ---");
  const balanceBefore = (await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
  })) as bigint;

  const denialHistoryStart = guard.history().length;
  let deniedRequestCompleted = false;
  try {
    await fetchWithPay(`http://localhost:${PORT + 1}/paid`);
    deniedRequestCompleted = true;
  } catch {
    // The observed hook result below distinguishes a policy denial from an
    // unrelated network failure without printing upstream error text.
  }
  const balanceAfter = (await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
  })) as bigint;

  const denialCreatedEvidence = guard.history().length !== denialHistoryStart;
  if (
    deniedRequestCompleted ||
    !observedPayeeDenial ||
    denialCreatedEvidence ||
    balanceBefore !== balanceAfter
  ) {
    throw new Error("non-allowlisted payment was not proven safely blocked");
  }
  console.log("USDC moved: 0 atomic units");
  console.log("✓ blocked: the guard denied a non-allowlisted payment before signing");

  strangerServer.close();
  server.close();
}

main()
  .then(() => process.exit(0))
  .catch(() => {
    console.error(
      "demo failed; if demo/ledger.jsonl predates schema v1, manually move it " +
        "aside for quarantine before rerunning; no upstream error text was printed",
    );
    process.exit(1);
  });

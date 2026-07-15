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

import { Guard, loadPolicy, JsonlLedgerStore, ViemChainReader, x402GuardHooks } from "../src/index.js";

const NETWORK = "eip155:84532" as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FACILITATOR = "https://x402.org/facilitator";
const PORT = 4021;

async function main() {
  const key = process.env["X402_TESTNET_KEY"];
  if (!key) throw new Error("set X402_TESTNET_KEY in .env (a funded Base Sepolia key)");

  const account = privateKeyToAccount(key as `0x${string}`);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

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
  const { policy, hash } = loadPolicy({
    policy: "demo", version: 1,
    asset: { symbol: "USDC", address: USDC, network: NETWORK, decimals: 6 },
    mandate: { holder: "demo", agent: "demo-agent", expires: new Date(now + 3600_000).toISOString() },
    payees: { allow: [{ name: "demo-seller", address: receiver }] },
    payments: { max_per_payment: "1.00", require_approval_over: "1.00" },
    budgets: [{ name: "daily", window: "rolling-24h", limit: "1.00" }],
    velocity: { max_payments_per_hour: 10 },
  }, now);

  const guard = await Guard.open({
    policy, policyHash: hash,
    store: new JsonlLedgerStore("./demo/ledger.jsonl"),
    chain: new ViemChainReader(),
    clock: { now: () => Date.now() },
  });

  // --- the guarded client --------------------------------------------------
  const signer = toClientEvmSigner(account, publicClient);
  const hooks = x402GuardHooks(guard);
  const client = x402Client
    .fromConfig({ schemes: [{ network: NETWORK, client: new ExactEvmScheme(signer) }] })
    .onBeforePaymentCreation(hooks.onBeforePaymentCreation)
    .onAfterPaymentCreation(hooks.onAfterPaymentCreation)
    .onPaymentResponse(hooks.onPaymentResponse)
    .onPaymentCreationFailure(hooks.onPaymentCreationFailure);

  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  console.log("\n--- paying GET /paid ($0.01) ---");
  const res = await fetchWithPay(`http://localhost:${PORT}/paid`);
  console.log("status:", res.status, await res.text());

  console.log("\n--- ledger (the audit trail) ---");
  for (const e of guard.history()) {
    console.log(`  ${e.status.padEnd(12)} ${e.holdId}${e.transaction ? "  tx=" + e.transaction : ""}`);
  }
  const settled = guard.history().find((e) => e.status === "settled");
  if (settled?.transaction) {
    console.log(`\n✓ settled on-chain: https://sepolia.basescan.org/tx/${settled.transaction}`);
  }

  // --- now try to pay a seller the policy does not allow --------------------
  console.log("\n--- attempting to pay a NON-allowlisted seller ($0.01) ---");
  const balanceBefore = (await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
  })) as bigint;

  const res2 = await fetchWithPay(`http://localhost:${PORT + 1}/paid`).catch((e) => ({ status: "blocked", err: String(e) }));
  const balanceAfter = (await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
  })) as bigint;

  console.log("result:", "status" in res2 ? res2.status : res2);
  console.log("USDC moved:", Number(balanceBefore - balanceAfter) / 1e6, "(want 0 — the guard blocked it before signing)");
  if (balanceBefore === balanceAfter) {
    console.log("✓ blocked: the guard denied a non-allowlisted payment and no money moved");
  }

  strangerServer.close();
  server.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

/**
 * Deterministic, no-network demonstration of cumulative durable policy.
 *
 * This does not create a wallet signature or invoke the x402 adapter. It uses
 * synthetic authorization metadata to exercise the Guard lifecycle directly.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Guard,
  JsonlLedgerStore,
  SETTLEMENT_PROFILE,
  loadPolicyFile,
} from "x402-guard";

const now = Date.UTC(2026, 6, 14, 12, 0, 0);
const policyPath = fileURLToPath(
  new URL("./research-agent.policy.yaml", import.meta.url),
);
const payer = "0x2222222222222222222222222222222222222222";
const payee = "0xE5f6070809A0b1C2d3E4f5061728394A5b6C7788";

const unresolvedChain = {
  profile: SETTLEMENT_PROFILE,
  async assertReady() {},
  async findPayment() {
    return { state: "unknown", reason: "authorization_still_live" };
  },
};

const payment = {
  amount: 1_800_000n,
  asset: SETTLEMENT_PROFILE.asset,
  network: SETTLEMENT_PROFILE.network,
  payTo: payee,
  resource: "https://api.example/report",
};

async function authorizeAndAttach(guard, sequence) {
  await guard.attestCallerApproval(payment);
  const result = await guard.authorize(payment);
  if (result.decision !== "allow") {
    throw new Error(`payment ${sequence} was unexpectedly ${result.decision}`);
  }

  const nonce = `0x${sequence.toString(16).padStart(64, "0")}`;
  await guard.attachAuthorization(
    result.holdId,
    nonce,
    payer,
    BigInt(Math.floor(now / 1_000) + 3_600),
  );
  console.log(
    `payment ${sequence}: ALLOW $1.80 — synthetic authorization attached durably`,
  );
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "x402-guard-mandate-"));
  const ledgerPath = join(directory, "ledger.jsonl");
  const loadedPolicy = await loadPolicyFile(policyPath, now);
  const options = {
    loadedPolicy,
    store: new JsonlLedgerStore(ledgerPath),
    chain: unresolvedChain,
    clock: { now: () => now },
  };

  let guard = await Guard.open(options);
  console.log("application policy: $5.00 rolling-24h; each request: $1.80\n");
  await authorizeAndAttach(guard, 1);
  await authorizeAndAttach(guard, 2);

  console.log("\nGuard reopen: reading the same durable ledger");
  guard = await Guard.open({ ...options, store: new JsonlLedgerStore(ledgerPath) });
  console.log("recovered committed amount: $3.60 (outcome still ambiguous)");

  await guard.attestCallerApproval(payment);
  const third = await guard.authorize(payment);
  if (third.decision !== "deny" || third.verdict.reason !== "budget_exceeded") {
    throw new Error("the third payment was not denied by the cumulative budget");
  }

  console.log("payment 3: DENY  $1.80 — projected $5.40 exceeds $5.00");
  console.log("result: no third authorization was admitted or attached");
  console.log(`evidence: ${ledgerPath}`);
}

main().catch(() => {
  console.error("mandate demo failed");
  process.exitCode = 1;
});

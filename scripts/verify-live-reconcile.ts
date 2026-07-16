/**
 * Reconcile the project's own cited proof settlement against the live chain.
 *
 * This runs the real ViemChainReader — no fakes — against Base Sepolia tx
 * 0x82ba06be, the public settlement recorded by this repository. It exists
 * because a bug once bound the Transfer on the wrong side of the AuthorizationUsed
 * log, and the fixtures hid it. A claim that reconciliation "meets the real chain"
 * has to be executed against the real chain, not asserted. Run: `npm run verify:live`.
 */
import { ViemChainReader } from "../src/adapters/viem-chain.js";
import type { EvidenceQuote } from "../src/policy.js";

const TX = "0x82ba06be4ad379fc4f61e14533b4812bfff366060e9c63368dc435a1249a5ce2";

// Extracted from the on-chain receipt of TX (Base Sepolia).
const PAYER = "0x26C5d77080AA51d76FfB86ACA04F8E2fD3229161";
const NONCE = "0x66a44e46a58ddae8e1b217febff93a210279e2e9af2d5692bd8271866f99a300";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const quote: EvidenceQuote = {
  amount: 10_000n, // 0x2710 = 0.01 USDC (6 decimals)
  asset: USDC,
  network: "eip155:84532",
  payTo: RECIPIENT,
  resourceHash: `sha256:${"1".repeat(64)}`,
};

// The settlement block's timestamp, so the search window reaches back to it.
const heldAt = 1_784_029_942 * 1000;
// Canonical EIP-3009 unix seconds from the signed payload cited by the demo.
const validBefore = 1_784_077_727n;

async function main() {
  const rpcUrl = process.env["BASE_SEPOLIA_RPC_URL"];
  const reader = rpcUrl
    ? new ViemChainReader({ rpcUrl })
    : new ViemChainReader();
  await reader.assertReady();
  const status = await reader.findPayment({
    quote,
    nonce: NONCE,
    payer: PAYER,
    validBefore,
    heldAt,
  });

  console.log(
    "findPayment against live Base Sepolia:",
    JSON.stringify(status, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );

  if (status.state === "settled" && status.transaction.toLowerCase() === TX) {
    console.log("PASS — reconciliation confirmed the real settlement on-chain.");
    return;
  }
  console.error("FAIL — finalized exact settlement proof was not found");
  process.exitCode = 1;
}

main().catch(() => {
  console.error("FAIL — live verification could not complete; upstream text withheld");
  process.exitCode = 1;
});

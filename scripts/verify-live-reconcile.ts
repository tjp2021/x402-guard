/**
 * Reconcile the project's own cited proof settlement against the live chain.
 *
 * This runs the real ViemChainReader — no fakes — against Base Sepolia tx
 * 0x82ba06be, the settlement the README and the #2823 comment cite. It exists
 * because a bug once bound the Transfer on the wrong side of the AuthorizationUsed
 * log, and the fixtures hid it. A claim that reconciliation "meets the real chain"
 * has to be executed against the real chain, not asserted. Run: `npm run verify:live`.
 */
import { ViemChainReader } from "../src/adapters/viem-chain.js";
import type { Quote } from "../src/policy.js";

const TX = "0x82ba06be4ad379fc4f61e14533b4812bfff366060e9c63368dc435a1249a5ce2";

// Extracted from the on-chain receipt of TX (Base Sepolia).
const PAYER = "0x26C5d77080AA51d76FfB86ACA04F8E2fD3229161";
const NONCE = "0x66a44e46a58ddae8e1b217febff93a210279e2e9af2d5692bd8271866f99a300";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const quote: Quote = {
  amount: 10_000n, // 0x2710 = 0.01 USDC (6 decimals)
  asset: USDC,
  network: "eip155:84532",
  payTo: RECIPIENT,
  resource: "https://demo.local/report",
};

// The settlement block's timestamp, so the search window reaches back to it.
const heldAt = 1_784_029_942 * 1000;

const reader = new ViemChainReader();
const status = await reader.findPayment({ quote, nonce: NONCE, payer: PAYER, heldAt });

console.log("findPayment against live Base Sepolia:", JSON.stringify(status));

if (status.found === true && status.transaction?.toLowerCase() === TX) {
  console.log("PASS — reconciliation confirmed the real settlement on-chain.");
  process.exit(0);
}
console.error("FAIL — expected found:true for", TX);
process.exit(1);

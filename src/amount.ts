/**
 * Amounts are integer atomic units (USDC has 6 decimals: 1.50 USDC = 1_500_000n).
 *
 * Money never touches a float in this codebase. `0.1 + 0.2 !== 0.3` is not a
 * curiosity here, it is a wrong authorization decision.
 *
 * x402 quotes `amount` as a decimal string of atomic units already
 * (PaymentRequirements.amount), so the wire format needs no scaling. Policies
 * are authored in human decimals ("1.50") and parsed once, at load.
 */

export type Atomic = bigint;

export class AmountError extends Error {}

/** Parse a human decimal string ("1.50") into atomic units at the given scale. */
export function parseDecimal(input: string, decimals: number): Atomic {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new AmountError(`invalid decimals: ${decimals}`);
  }
  const trimmed = input.trim();
  // No signs, no exponents, no leading '+'. Money is unsigned here; a negative
  // limit is a policy authoring bug, not something to silently normalize.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new AmountError(`not a plain decimal amount: ${JSON.stringify(input)}`);
  }
  const [whole = "", frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    // Refuse rather than round. Rounding a spending limit down is a silent
    // loosening; rounding up is a silent tightening. Both are lies.
    throw new AmountError(
      `${trimmed} has ${frac.length} decimal places, exceeds scale ${decimals}`,
    );
  }
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/** Parse an on-wire atomic-unit string ("1500000") as x402 quotes it. */
export function parseAtomic(input: string): Atomic {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new AmountError(`not an atomic-unit integer: ${JSON.stringify(input)}`);
  }
  return BigInt(trimmed);
}

/** Render atomic units as a human decimal string, for verdicts and reports. */
export function formatAmount(value: Atomic, decimals: number): string {
  if (value < 0n) throw new AmountError(`negative amount: ${value}`);
  const s = value.toString().padStart(decimals + 1, "0");
  const cut = s.length - decimals;
  const whole = s.slice(0, cut);
  const frac = s.slice(cut);
  return decimals === 0 ? whole : `${whole}.${frac}`;
}

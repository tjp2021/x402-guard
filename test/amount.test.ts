import { describe, it, expect } from "vitest";
import { parseDecimal, parseAtomic, formatAmount, AmountError } from "../src/amount.js";

const USDC = 6;

describe("parseDecimal", () => {
  it("scales human decimals to atomic units", () => {
    expect(parseDecimal("1.50", USDC)).toBe(1_500_000n);
    expect(parseDecimal("0.50", USDC)).toBe(500_000n);
    expect(parseDecimal("5", USDC)).toBe(5_000_000n);
    expect(parseDecimal("0.000001", USDC)).toBe(1n);
    expect(parseDecimal("0", USDC)).toBe(0n);
  });

  it("does not lose precision the way floats do", () => {
    // The reason this module exists: 0.1 + 0.2 !== 0.3 in IEEE-754.
    const sum = parseDecimal("0.1", USDC) + parseDecimal("0.2", USDC);
    expect(sum).toBe(parseDecimal("0.3", USDC));
    expect(0.1 + 0.2).not.toBe(0.3); // the bug we are refusing to inherit
  });

  it("survives amounts that overflow a float's integer range", () => {
    // 2^53 atomic units is where Number silently stops counting.
    const big = parseDecimal("9007199254.740993", USDC);
    expect(big).toBe(9_007_199_254_740_993n);
    expect(big).not.toBe(BigInt(Number(9_007_199_254_740_993n))); // Number lies here
  });

  it("refuses more precision than the asset has, rather than rounding", () => {
    // Rounding down silently loosens a limit; rounding up silently tightens it.
    expect(() => parseDecimal("1.0000005", USDC)).toThrow(AmountError);
  });

  it("rejects anything that is not a plain unsigned decimal", () => {
    for (const bad of ["-1.00", "+1.00", "1e6", "1_000", "", " ", "1.2.3", "abc", "Infinity", "NaN", ".5", "1."]) {
      expect(() => parseDecimal(bad, USDC), `should reject ${JSON.stringify(bad)}`).toThrow(AmountError);
    }
  });
});

describe("parseAtomic", () => {
  it("reads x402's on-wire atomic-unit strings", () => {
    expect(parseAtomic("1500000")).toBe(1_500_000n);
    expect(parseAtomic("0")).toBe(0n);
  });

  it("rejects decimals on the wire — x402 quotes atomic units, not decimals", () => {
    // If a server sends "1.50" where atomic units are expected, treating it as
    // 1.5 units instead of 1,500,000 would under-count the spend by 10^6.
    expect(() => parseAtomic("1.50")).toThrow(AmountError);
    expect(() => parseAtomic("-1")).toThrow(AmountError);
    expect(() => parseAtomic("")).toThrow(AmountError);
  });
});

describe("formatAmount", () => {
  it("round-trips with parseDecimal", () => {
    for (const s of ["0.000000", "0.500000", "1.500000", "5.000000", "123456.789012"]) {
      expect(formatAmount(parseDecimal(s, USDC), USDC)).toBe(s);
    }
  });

  it("pads amounts smaller than one whole unit", () => {
    expect(formatAmount(1n, USDC)).toBe("0.000001");
    expect(formatAmount(0n, USDC)).toBe("0.000000");
  });

  it("handles a zero-decimal asset", () => {
    expect(formatAmount(42n, 0)).toBe("42");
  });
});

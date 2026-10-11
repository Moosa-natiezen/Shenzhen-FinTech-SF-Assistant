/**
 * Exact-decimal money arithmetic (invariant I-10: never floats).
 *
 * All monetary amounts are NUMERIC(20,8). We carry them internally as signed
 * BigInt "minor units" scaled by 10^8 so every operation is integer math:
 *   parse("12.34")  -> 1234000000n
 *   format(1234000000n) -> "12.34000000"
 * Multiplication (used for FX) divides by SCALE with round-half-up, so results
 * stay exact and reproducible — no IEEE-754 ever touches an amount.
 */

export const MONEY_SCALE = 8;
const SCALE = 10n ** BigInt(MONEY_SCALE);
const HALF = SCALE / 2n;

/** Parses a decimal string (<= 8 dp) into scaled minor units. Throws on junk. */
export function parseMoney(value: string): bigint {
  if (typeof value !== "string" || !/^-?\d+(\.\d{1,8})?$/.test(value.trim())) {
    throw new Error(`invalid money amount: ${JSON.stringify(value)}`);
  }
  const neg = value.trim().startsWith("-");
  const cleaned = value.trim().replace("-", "");
  const dot = cleaned.indexOf(".");
  const intPart = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const fracPart = dot === -1 ? "" : cleaned.slice(dot + 1);
  const frac = (fracPart + "0".repeat(MONEY_SCALE)).slice(0, MONEY_SCALE);
  const scaled = BigInt(intPart) * SCALE + BigInt(frac);
  return neg ? -scaled : scaled;
}

/** Formats scaled minor units back into an 8-decimal string for storage. */
export function formatMoney(scaled: bigint): string {
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const intPart = abs / SCALE;
  const fracPart = abs % SCALE;
  const frac = fracPart.toString().padStart(MONEY_SCALE, "0");
  return `${neg ? "-" : ""}${intPart.toString()}.${frac}`;
}

/** (a * b) / SCALE with round-half-up, staying in scaled minor units. */
export function mulScaled(a: bigint, b: bigint): bigint {
  const product = a * b;
  return product >= 0n ? (product + HALF) / SCALE : -((-product + HALF) / SCALE);
}

/** Sum of a list of scaled amounts (for zero-sum double-entry checks). */
export function sumScaled(values: readonly bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, 0n);
}

/** True when the scaled value is strictly positive. */
export function isPositive(scaled: bigint): boolean {
  return scaled > 0n;
}

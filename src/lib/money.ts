/** Client-side display helpers. Authoritative money math is server-side (I-10). */
export function fmt(value: string | number, currency?: string): string {
  const n = typeof value === "string" ? Number(value) : value;
  const s = Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00";
  return currency ? `${s} ${currency}` : s;
}
/** Display estimate of host credit = (base − fee) × rate. Server recomputes exactly. */
export function estimateHostCredit(amountBase: string, feeFlat: string, fxFinal: string): string {
  const net = Number(amountBase) - Number(feeFlat);
  return (net * Number(fxFinal)).toFixed(8);
}

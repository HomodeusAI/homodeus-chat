// Parse a query-string value as a non-negative safe integer. Returns undefined for missing, NaN,
// fractional, negative, or out-of-range input, so a bad ?tail=abc is ignored instead of reaching
// SQL as `limit NaN` (a 500).
export function intParam(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : undefined;
}

/**
 * Normalizes a numeric dbf field value, converting SLC's "no data" sentinels
 * (most commonly `-9`) to `null` so downstream code doesn't mistake "no data"
 * for a real measurement of zero or a small negative number.
 *
 * @param value - The raw value read from a dbf record. Only `number`s are
 *   considered; anything else (e.g. `undefined`, `NaN`) also normalizes to `null`.
 * @param sentinels - The set of numeric values that represent "no data" for
 *   this field. Defaults to `[-9]`, the sentinel used by most SLC numeric
 *   fields (e.g. `TSAND`, `TSILT`, `TCLAY` in the soil layer table).
 * @returns The original number, or `null` if it was missing/invalid/a sentinel.
 */
export function numOrNull(
  value: unknown,
  sentinels: number[] = [-9],
): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return sentinels.includes(value) ? null : value;
}

/**
 * Normalizes a coded text dbf field value, converting SLC's "not applicable"
 * placeholders (`'-'` or an empty/whitespace string) to `null`.
 *
 * @param value - The raw value read from a dbf record. Only `string`s are
 *   considered; anything else normalizes to `null`.
 * @returns The trimmed string, or `null` if it was missing/blank/a placeholder.
 */
export function strOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === '-' ? null : trimmed;
}

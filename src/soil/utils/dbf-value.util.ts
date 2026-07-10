/** SLC dbf tables use -9 (and similar) as a numeric "no data" sentinel. */
export function numOrNull(
  value: unknown,
  sentinels: number[] = [-9],
): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return sentinels.includes(value) ? null : value;
}

/** SLC dbf tables use '-' or blank as a "not applicable" placeholder for coded text fields. */
export function strOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === '-' ? null : trimmed;
}

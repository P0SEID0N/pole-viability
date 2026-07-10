/** Clamps a value to the [0, 1] range every risk sub-score is expressed in. */
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Maps `value` onto a [0, 1] risk score via linear interpolation between two
 * reference points: `zeroRiskAt` (where risk bottoms out at 0) and
 * `oneRiskAt` (where risk maxes out at 1). `zeroRiskAt` can be greater than
 * `oneRiskAt` to express an inverted relationship (e.g. risk rises as a
 * value *falls*, like a shrinking frost-free period). Values beyond either
 * reference point clamp rather than extrapolate past 0/1.
 */
export function linearRisk(
  value: number,
  zeroRiskAt: number,
  oneRiskAt: number,
): number {
  return clamp01((value - zeroRiskAt) / (oneRiskAt - zeroRiskAt));
}

/**
 * Rounds a risk score to 2 decimal places for display in the API response.
 * The full-precision value is what gets logged (see `RiskScoringService`) —
 * this rounding is purely a presentation concern, not part of the formula.
 */
export function roundTo2Decimals(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The row persisted per (lat, lng) in the score cache. Carries more than
 * just the public `PoleViabilityScore` fields — `soilWetnessRisk` and
 * `meanWindSpeedKmh` are the specific derived values `RiskScoringService`
 * needs to recompute `shortTermRisk` on a cache hit without re-fetching
 * soil or climate normals (see `RiskScoringService.calculateShortTermRiskOnly`).
 */
export interface CachedScore {
  lat: number;
  lng: number;
  longTermRisk: number;
  shortTermRisk: number;
  overallRisk: number;
  /** Needed to recompute `freezeThawTransitionRisk` on a cache hit. */
  soilWetnessRisk: number;
  /** Needed to recompute `windAnomalyRisk` on a cache hit. Nullable since climate normals can lack this element. */
  meanWindSpeedKmh: number | null;
  /** When this row was first computed (full soil + climate + current-conditions lookup). */
  computedAt: string;
  /** When `shortTermRisk`/`overallRisk` were last refreshed (every request, hit or miss). */
  updatedAt: string;
}

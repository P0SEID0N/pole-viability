/**
 * The computed pole fall-risk score for a location, derived from
 * `SoilRiskProfile` + `ClimateRiskProfile` (structural baseline) and
 * `CurrentConditionsProfile` (live modifier). See README.md "Scoring
 * formula" for the full reasoning behind every threshold/weight — this is
 * a research-informed heuristic, not a fitted model (no real pole-failure
 * data exists to calibrate against).
 *
 * This is the entire `GET /viability` response — deliberately just the
 * three risk numbers, not the raw soil/climate/current-conditions profiles
 * they were derived from. `contributingFactors` is logged instead, at full
 * precision (see README.md "Scoring formula" > Logging); `overallRisk`,
 * `shortTermRisk`, and `longTermRisk` here are rounded to 2 decimal places
 * for display, while the logged values retain full precision.
 */
export interface PoleViabilityScore {
  /** false when soil, climate normals, or current conditions data is unavailable for this location — null rather than a guessed risk. */
  dataAvailable: boolean;
  /** [0, 1], rounded to 2 decimal places. Full-precision value is logged, not returned. */
  overallRisk: number | null;
  /** [0, 1], rounded to 2 decimal places — risk from live conditions (wind anomaly, freeze-thaw transition) on top of the structural baseline. */
  shortTermRisk: number | null;
  /** [0, 1], rounded to 2 decimal places — risk from structural soil/30-year-climate-normal factors. */
  longTermRisk: number | null;
}

/**
 * The subset of a full computation's state needed to recompute
 * `shortTermRisk` later without re-fetching soil or climate normals — what
 * `ScoreCacheRepository` persists per location, and what
 * `RiskScoringService.calculateShortTermRiskOnly` consumes on a cache hit.
 * `longTermRisk` and `soilWetnessRisk` are full-precision (unrounded) here,
 * unlike the rounded copy in `PoleViabilityScore`.
 */
export interface CacheableLongTermRisk {
  longTermRisk: number;
  /** Needed to recompute `freezeThawTransitionRisk` without re-fetching soil. */
  soilWetnessRisk: number;
  /** Needed to recompute `windAnomalyRisk` without re-fetching climate normals. */
  meanWindSpeedKmh: number | null;
}

/**
 * The full-precision breakdown behind a `PoleViabilityScore` — every named
 * sub-score that fed `longTermRisk`/`shortTermRisk`/`overallRisk`. Logged
 * by `RiskScoringService` for observability/debugging, not returned from
 * the API. Kept as its own type (rather than folded into
 * `PoleViabilityScore`) so it's clear this is internal detail, not part of
 * the response contract.
 */
export interface ViabilityRiskBreakdown {
  longTermRisk: number;
  shortTermRisk: number;
  overallRisk: number;
  contributingFactors: {
    longTerm: {
      /** Depth-to-restriction class averaged with bulk-density risk — how deep a footing can go, and how much resistance the soil there actually provides. */
      footingDepthRisk: number;
      /** Bulk density (SLT.BD) risk alone, before averaging into footingDepthRisk — surfaced separately for transparency. */
      bulkDensityRisk: number;
      /** Static drainage-class + water-table risk, amplified by clay content and slope. */
      soilWetnessRisk: number;
      /** Precipitation load × how slowly the soil drains it (KSAT) — how long the soil likely stays saturated after rain. */
      saturationDurationRisk: number;
      /** Normal wind exposure, amplified when footing depth is shallow. */
      windRisk: number;
      /** Freeze-thaw cycle exposure from climate normals, amplified by soil wetness. */
      freezeThawRisk: number;
      /** Flat risk bump for organic/unclassified soil (poor bearing capacity), 0 for ordinary mineral soil. */
      organicSoilRisk: number;
    };
    shortTerm: {
      /** Current wind gust vs. this location's normal wind, and against an absolute storm-force floor. */
      windAnomalyRisk: number;
      /** How close current temperature is to 0°C right now, amplified by soil wetness. */
      freezeThawTransitionRisk: number;
    };
  };
}

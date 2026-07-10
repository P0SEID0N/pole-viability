import { Injectable, Logger } from '@nestjs/common';
import { SoilRiskProfile } from '../soil/interfaces/soil-risk-profile.interface';
import { ClimateRiskProfile } from '../climate/interfaces/climate-risk-profile.interface';
import { CurrentConditionsProfile } from '../climate/interfaces/current-conditions-profile.interface';
import {
  CacheableLongTermRisk,
  PoleViabilityScore,
  ViabilityRiskBreakdown,
} from './interfaces/pole-viability-score.interface';
import { clamp01, linearRisk, roundTo2Decimals } from './utils/risk-math.util';

/**
 * Ordinal risk for `SNT.DRAINAGE` (best → worst drained), per the AAFC
 * legend (sis.agr.gc.ca/cansis/nsdb/soil/v2/snt/drainage.html). Poorer
 * drainage means water sits in the soil longer, which is what actually
 * weakens bearing capacity — this is the static/classification half of
 * "how wet does this soil typically get" (see `saturationDurationRisk` for
 * the dynamic, precipitation-driven half).
 */
const DRAINAGE_RISK: Record<string, number> = {
  VR: 0.0,
  R: 0.05,
  W: 0.15,
  MW: 0.3,
  I: 0.5,
  P: 0.75,
  VP: 1.0,
};
/** Unknown/not-applicable drainage — mild caution rather than assuming the best case. */
const DEFAULT_DRAINAGE_RISK = 0.4;

/** Ordinal risk for `SNT.WATERTBL`, per the AAFC legend. A permanently present water table keeps soil saturated year-round. */
const WATER_TABLE_RISK: Record<string, number> = {
  NO: 0.0,
  YU: 0.4,
  YN: 0.5,
  YG: 0.7,
  YB: 1.0,
};
const DEFAULT_WATER_TABLE_RISK = 0.3;

/**
 * Risk for `CRT.DEPTH` class (root/footing depth before bedrock, hardpan, or
 * water table), per the AAFC legend: 1 = <25cm, 5 = >=100cm. Averaged with
 * `calculateBulkDensityRisk` into `footingDepthRisk` — depth alone answers
 * "how far down can a footing go," not "how much resistance the soil there
 * actually provides", which is what determines real overturning resistance.
 */
const DEPTH_CLASS_RISK: Record<string, number> = {
  '1': 1.0,
  '2': 0.75,
  '3': 0.5,
  '4': 0.25,
  '5': 0.0,
};
/** Missing or '-' (non-applicable — e.g. rock at surface): treat as the worst case, not the best. */
const DEFAULT_DEPTH_CLASS_RISK = 1.0;
/** Typical mineral soil bulk density when no layer data exists — mid-range, not an assumption of good or bad soil. */
const DEFAULT_BULK_DENSITY_G_CM3 = 1.3;

/** Flat risk bump for `SNT.KIND` — organic/peat soil has materially worse bearing capacity than mineral soil. */
const ORGANIC_SOIL_RISK_BUMP = 0.3;
/** Smaller bump for unclassified/non-soil `KIND` codes — genuinely unknown, not "safe by default". */
const UNKNOWN_KIND_RISK_BUMP = 0.1;

/** Weights for the long-term sub-scores. Sum to 1.0 (organicSoilRisk is an additive bump on top, not part of this split). Unvalidated — see README.md. */
const LONG_TERM_WEIGHTS = {
  footingDepth: 0.25,
  soilWetness: 0.2,
  saturationDuration: 0.15,
  wind: 0.2,
  freezeThaw: 0.2,
};

/** How much of `shortTermRisk` gets added on top of `longTermRisk` for `overallRisk`. See README.md for why this is additive, not a blended average. */
const SHORT_TERM_CONTRIBUTION_WEIGHT = 0.3;

@Injectable()
export class RiskScoringService {
  private readonly logger = new Logger(RiskScoringService.name);

  /**
   * Computes the pole fall-risk score for a location from its already-
   * fetched soil, climate-normals, and current-conditions profiles. A pure
   * function aside from logging: no I/O here, just the formula — fetching
   * the three input profiles is the caller's job (see `PoleViabilityService`).
   * This is the full/cache-miss path; see `calculateShortTermRiskOnly` for
   * the cache-hit path that skips re-deriving `longTermRisk`.
   *
   * The full-precision breakdown (`contributingFactors`, plus unrounded
   * copies of the three risk numbers) is logged rather than returned — see
   * README.md "Scoring formula" > Logging. The public `score` carries only
   * `overallRisk`/`shortTermRisk`/`longTermRisk`, each rounded to 2 decimal
   * places for display.
   *
   * @returns `score` with `dataAvailable: false` and every risk field
   *   `null`, and `cacheable: null`, if any of the three inputs are
   *   themselves unavailable for this location — a long-term score without
   *   climate data (or vice versa) would be missing half its inputs, not
   *   just a lower-confidence version of the real answer. Otherwise
   *   `cacheable` carries the unrounded state `ScoreCacheRepository` needs
   *   to persist for a future cache hit.
   */
  calculateViabilityScore(
    soil: SoilRiskProfile,
    climate: ClimateRiskProfile,
    current: CurrentConditionsProfile,
  ): { score: PoleViabilityScore; cacheable: CacheableLongTermRisk | null } {
    if (
      !soil.dataAvailable ||
      !climate.dataAvailable ||
      !current.dataAvailable
    ) {
      this.logger.log(
        `Viability score unavailable for (${soil.location.lat}, ${soil.location.lng}): ` +
          `soil.dataAvailable=${soil.dataAvailable}, climate.dataAvailable=${climate.dataAvailable}, ` +
          `current.dataAvailable=${current.dataAvailable}`,
      );
      return {
        score: {
          dataAvailable: false,
          overallRisk: null,
          shortTermRisk: null,
          longTermRisk: null,
        },
        cacheable: null,
      };
    }

    const normals = climate.normals!;
    const conditions = current.conditions!;
    const layer = soil.layers[0];

    const depthClassRisk =
      DEPTH_CLASS_RISK[soil.depthToRestriction?.depthClass ?? ''] ??
      DEFAULT_DEPTH_CLASS_RISK;
    const bulkDensityRisk = this.calculateBulkDensityRisk(
      layer?.bulkDensity ?? null,
    );
    // Real overturning resistance depends on soil strength within the embedment
    // zone, not just how deep a footing can physically reach — averaging depth
    // class with bulk density folds that in rather than relying on depth alone.
    const footingDepthRisk = clamp01((depthClassRisk + bulkDensityRisk) / 2);

    const soilWetnessRisk = this.calculateSoilWetnessRisk(soil);
    const saturationDurationRisk = this.calculateSaturationDurationRisk(
      normals.totalPrecipitationMm,
      layer?.saturatedHydraulicConductivity ?? null,
    );
    const windRisk = this.calculateWindContribution(
      normals.meanWindSpeedKmh,
      normals.highWindDaysPerYear,
      footingDepthRisk,
    );
    const freezeThawRisk = this.calculateFreezeThawContribution(
      normals.frostFreePeriodDays,
      normals.degreeDaysBelowZero,
      soilWetnessRisk,
    );
    const organicSoilRisk = this.calculateOrganicSoilRisk(
      soil.drainage?.kind ?? null,
    );

    const longTermRisk = clamp01(
      footingDepthRisk * LONG_TERM_WEIGHTS.footingDepth +
        soilWetnessRisk * LONG_TERM_WEIGHTS.soilWetness +
        saturationDurationRisk * LONG_TERM_WEIGHTS.saturationDuration +
        windRisk * LONG_TERM_WEIGHTS.wind +
        freezeThawRisk * LONG_TERM_WEIGHTS.freezeThaw +
        organicSoilRisk,
    );

    const windAnomalyRisk = this.calculateWindAnomalyRisk(
      conditions.windGustKmh ?? conditions.windSpeedKmh,
      normals.meanWindSpeedKmh,
    );
    const freezeThawTransitionRisk = this.calculateFreezeThawTransitionRisk(
      conditions.temperatureCelsius,
      soilWetnessRisk,
    );

    const shortTermRisk = clamp01(
      windAnomalyRisk * 0.6 + freezeThawTransitionRisk * 0.4,
    );

    const overallRisk = clamp01(
      longTermRisk + shortTermRisk * SHORT_TERM_CONTRIBUTION_WEIGHT,
    );

    const breakdown: ViabilityRiskBreakdown = {
      longTermRisk,
      shortTermRisk,
      overallRisk,
      contributingFactors: {
        longTerm: {
          footingDepthRisk,
          bulkDensityRisk,
          soilWetnessRisk,
          saturationDurationRisk,
          windRisk,
          freezeThawRisk,
          organicSoilRisk,
        },
        shortTerm: {
          windAnomalyRisk,
          freezeThawTransitionRisk,
        },
      },
    };
    this.logger.log(
      `Viability score for (${soil.location.lat}, ${soil.location.lng}): ${JSON.stringify(breakdown)}`,
    );

    return {
      score: {
        dataAvailable: true,
        overallRisk: roundTo2Decimals(overallRisk),
        shortTermRisk: roundTo2Decimals(shortTermRisk),
        longTermRisk: roundTo2Decimals(longTermRisk),
      },
      cacheable: {
        longTermRisk,
        soilWetnessRisk,
        meanWindSpeedKmh: normals.meanWindSpeedKmh,
      },
    };
  }

  /**
   * Recomputes just `shortTermRisk` from live current conditions, reusing a
   * previously-cached `longTermRisk` (and the `soilWetnessRisk`/
   * `meanWindSpeedKmh` its sub-calculations need) instead of re-fetching
   * soil or climate normals. This is the cache-hit path — see
   * `calculateViabilityScore` for the full computation.
   *
   * @returns `dataAvailable: false` with every risk field `null` if current
   *   conditions are themselves unavailable — same "missing an input, not
   *   just lower-confidence" reasoning as the full path. Otherwise
   *   `shortTermRisk` is freshly computed and `overallRisk` is derived from
   *   the fresh short-term risk plus the cached long-term risk.
   */
  calculateShortTermRiskOnly(
    current: CurrentConditionsProfile,
    cached: CacheableLongTermRisk,
  ): PoleViabilityScore {
    if (!current.dataAvailable) {
      this.logger.log(
        `Short-term risk recompute unavailable for (${current.location.lat}, ${current.location.lng}): current.dataAvailable=false`,
      );
      return {
        dataAvailable: false,
        overallRisk: null,
        shortTermRisk: null,
        longTermRisk: null,
      };
    }

    const conditions = current.conditions!;
    const windAnomalyRisk = this.calculateWindAnomalyRisk(
      conditions.windGustKmh ?? conditions.windSpeedKmh,
      cached.meanWindSpeedKmh,
    );
    const freezeThawTransitionRisk = this.calculateFreezeThawTransitionRisk(
      conditions.temperatureCelsius,
      cached.soilWetnessRisk,
    );
    const shortTermRisk = clamp01(
      windAnomalyRisk * 0.6 + freezeThawTransitionRisk * 0.4,
    );
    const overallRisk = clamp01(
      cached.longTermRisk + shortTermRisk * SHORT_TERM_CONTRIBUTION_WEIGHT,
    );

    this.logger.log(
      `Recomputed short-term risk for (${current.location.lat}, ${current.location.lng}) using cached longTermRisk=${cached.longTermRisk}: ` +
        `${JSON.stringify({ shortTermRisk, overallRisk, windAnomalyRisk, freezeThawTransitionRisk })}`,
    );

    return {
      dataAvailable: true,
      overallRisk: roundTo2Decimals(overallRisk),
      shortTermRisk: roundTo2Decimals(shortTermRisk),
      longTermRisk: roundTo2Decimals(cached.longTermRisk),
    };
  }

  /**
   * Risk from soil bulk density (`SLT.BD`, g/cm³) — a bearing-capacity
   * proxy flagged by external review as collected but previously unused:
   * loose soil offers less resistance to lateral displacement than dense
   * soil. Typical mineral soil ranges from ~0.9 g/cm³ (loose, often
   * organic-influenced) to 1.6+ g/cm³ (dense/compact).
   */
  private calculateBulkDensityRisk(bulkDensity: number | null): number {
    // 1.6 g/cm3 (dense) -> 0 risk; 0.9 g/cm3 (loose) -> max risk. Inverted: lower density = higher risk.
    return linearRisk(bulkDensity ?? DEFAULT_BULK_DENSITY_G_CM3, 1.6, 0.9);
  }

  /**
   * Static "how wet does this soil typically get" risk: drainage class and
   * water table presence (each from the AAFC ordinal legends above),
   * amplified by clay content (clay soils are strong dry but weak wet —
   * see README.md "Assumptions") and by slope (saturated/thawing soil
   * creeps more on a grade than on flat ground).
   */
  private calculateSoilWetnessRisk(soil: SoilRiskProfile): number {
    const drainageRisk =
      DRAINAGE_RISK[soil.drainage?.drainageClass ?? ''] ??
      DEFAULT_DRAINAGE_RISK;
    const waterTableRisk =
      WATER_TABLE_RISK[soil.drainage?.waterTableClass ?? ''] ??
      DEFAULT_WATER_TABLE_RISK;
    const baseWetnessRisk = (drainageRisk + waterTableRisk) / 2;

    const clayPercent = soil.layers[0]?.clayPercent;
    // 20% clay -> no amplification; 60%+ clay (heavy clay, e.g. Regina series) -> 1.5x.
    const clayAmplifier = 1 + 0.5 * linearRisk(clayPercent ?? 30, 20, 60);

    const slopePercent = soil.landform?.slopePercent;
    // Flat ground -> no amplification; 30%+ grade -> 1.5x.
    const slopeAmplifier = 1 + 0.5 * linearRisk(slopePercent ?? 0, 0, 30);

    return clamp01(baseWetnessRisk * clayAmplifier * slopeAmplifier);
  }

  /**
   * Dynamic "how long does this soil stay saturated after rain" risk:
   * annual precipitation load × how slowly the soil drains it (`KSAT`).
   * Deliberately multiplicative, not additive — heavy rain on fast-draining
   * soil isn't a saturation problem, and slow drainage in a dry climate
   * rarely gets saturated in the first place. This is the direct
   * implementation of the rain/`KSAT` link in README.md "Assumptions".
   */
  private calculateSaturationDurationRisk(
    totalPrecipitationMm: number | null,
    saturatedHydraulicConductivity: number | null,
  ): number {
    // 200mm/yr (dry Prairies) -> 0 risk; 1200mm/yr (wet coastal BC) -> max.
    const precipRisk = linearRisk(totalPrecipitationMm ?? 500, 200, 1200);
    // KSAT in cm/hr: 10 (fast, sandy) -> 0 risk; 0.1 (very slow, heavy clay) -> max.
    const slownessRisk = linearRisk(
      saturatedHydraulicConductivity ?? 2,
      10,
      0.1,
    );
    return clamp01(precipRisk * slownessRisk);
  }

  /**
   * Wind loads the pole directly and independent of soil moisture (see
   * README.md "Assumptions"), but a shallow footing resists that load far
   * worse than a deep one — amplify by `footingDepthRisk` rather than
   * combining with the wetness factors.
   */
  private calculateWindContribution(
    meanWindSpeedKmh: number | null,
    highWindDaysPerYear: number | null,
    footingDepthRisk: number,
  ): number {
    // 10 km/h mean -> 0 risk; 30 km/h mean (quite windy) -> max.
    const meanWindRisk = linearRisk(meanWindSpeedKmh ?? 15, 10, 30);
    // 5 high-wind days/yr -> 0 risk; 60+ (very windy prairie/coastal site) -> max.
    const highWindDaysRisk = linearRisk(highWindDaysPerYear ?? 10, 5, 60);
    const windRisk = (meanWindRisk + highWindDaysRisk) / 2;
    // A deep, well-anchored footing (footingDepthRisk=0) halves wind's effective contribution.
    return clamp01(windRisk * (0.5 + 0.5 * footingDepthRisk));
  }

  /**
   * Freeze-thaw cycling from climate normals, amplified by soil wetness
   * (dry soil freezing doesn't heave much — see README.md "Assumptions").
   */
  private calculateFreezeThawContribution(
    frostFreePeriodDays: number | null,
    degreeDaysBelowZero: number | null,
    soilWetnessRisk: number,
  ): number {
    // 220-day frost-free period -> 0 risk; 60 days (short, harsh winter) -> max. Inverted: shorter period = higher risk.
    const frostFreeRisk = linearRisk(frostFreePeriodDays ?? 150, 220, 60);
    // 200 degree-days below 0 -> 0 risk; 3000 (deep Prairie/northern winter) -> max.
    const coldIntensityRisk = linearRisk(
      degreeDaysBelowZero ?? 1000,
      200,
      3000,
    );
    const freezeThawRisk = (frostFreeRisk + coldIntensityRisk) / 2;
    return clamp01(freezeThawRisk * (0.5 + 0.5 * soilWetnessRisk));
  }

  /** Flat risk bump for organic (`KIND: 'O'`) or unclassified/non-soil (`'U'`/`'N'`) soil. Ordinary mineral soil (`'M'`) contributes nothing here. */
  private calculateOrganicSoilRisk(kind: string | null): number {
    if (kind === 'O') return ORGANIC_SOIL_RISK_BUMP;
    if (kind === 'M') return 0;
    return UNKNOWN_KIND_RISK_BUMP;
  }

  /**
   * How far current wind gust is above (a) this location's normal wind and
   * (b) an absolute storm-force floor, whichever reads higher. Anomaly
   * alone would under-react in a location whose "normal" is already windy;
   * an absolute floor alone would miss a smaller-but-unusual local spike.
   */
  private calculateWindAnomalyRisk(
    currentWindGustKmh: number,
    normalMeanWindSpeedKmh: number | null,
  ): number {
    // 0 km/h above normal -> 0 risk; 40 km/h above normal -> max.
    const anomalyRisk = linearRisk(
      currentWindGustKmh - (normalMeanWindSpeedKmh ?? 15),
      0,
      40,
    );
    // Below 40 km/h gust -> 0 risk regardless of normal; 100 km/h (storm-force) -> max.
    const absoluteRisk = linearRisk(currentWindGustKmh, 40, 100);
    return Math.max(anomalyRisk, absoluteRisk);
  }

  /**
   * How close the current temperature is to 0°C right now — the active
   * freeze-thaw boundary, where ice lens formation/dissipation actually
   * happens — amplified by soil wetness (nothing to freeze in dry soil).
   */
  private calculateFreezeThawTransitionRisk(
    temperatureCelsius: number,
    soilWetnessRisk: number,
  ): number {
    // Peaks at exactly 0°C, tapers to 0 risk by +/-5°C away.
    const transitionRisk = clamp01(1 - Math.abs(temperatureCelsius) / 5);
    return clamp01(transitionRisk * (0.5 + 0.5 * soilWetnessRisk));
  }
}

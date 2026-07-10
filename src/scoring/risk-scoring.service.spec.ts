import { Logger } from '@nestjs/common';
import { RiskScoringService } from './risk-scoring.service';
import {
  CacheableLongTermRisk,
  ViabilityRiskBreakdown,
} from './interfaces/pole-viability-score.interface';
import { SoilRiskProfile } from '../soil/interfaces/soil-risk-profile.interface';
import { ClimateRiskProfile } from '../climate/interfaces/climate-risk-profile.interface';
import { CurrentConditionsProfile } from '../climate/interfaces/current-conditions-profile.interface';

const LOCATION = { lat: 50.4452, lng: -104.6189 };

/** Regina, SK — real values pulled from the live services during development (see README.md "Scoring formula"). */
function reginaSoil(overrides: Partial<SoilRiskProfile> = {}): SoilRiskProfile {
  return {
    location: LOCATION,
    polygonId: 792004,
    dataAvailable: true,
    component: {
      percentOfPolygon: 87,
      stoninessClass: 'N',
      soilId: 'SKRAA~~~~~A',
      soilName: 'REGINA O.V',
    },
    depthToRestriction: { depthClass: '5', restrictionType: null },
    drainage: { kind: 'M', drainageClass: 'W', waterTableClass: 'NO' },
    layers: [
      {
        layerNo: 1,
        upperDepthCm: 0,
        lowerDepthCm: 13,
        bulkDensity: 1.2,
        sandPercent: 8,
        siltPercent: 30,
        clayPercent: 62,
        saturatedHydraulicConductivity: 0.34,
      },
    ],
    landform: {
      slopePercent: 2,
      slopeSegmentPercent: 50,
      name: 'Undulating, A slope, Mid',
    },
    ...overrides,
  };
}

function reginaClimate(
  overrides: Partial<ClimateRiskProfile> = {},
): ClimateRiskProfile {
  return {
    location: LOCATION,
    dataAvailable: true,
    station: {
      climateIdentifier: '4016560',
      name: "REGINA INT'L A",
      distanceKm: 3.6,
      normalPeriod: { begin: 1981, end: 2010 },
    },
    normals: {
      meanWindSpeedKmh: 18.42,
      highWindDaysPerYear: 29.48,
      totalPrecipitationMm: 389.67,
      frostFreePeriodDays: 115,
      degreeDaysBelowZero: 1573.16,
    },
    ...overrides,
  };
}

function reginaCurrentConditions(
  overrides: Partial<CurrentConditionsProfile> = {},
): CurrentConditionsProfile {
  return {
    location: LOCATION,
    dataAvailable: true,
    city: { identifier: 'sk-32', name: 'Regina', distanceKm: 0.54 },
    conditions: {
      observedAt: '2026-07-10T16:00:00Z',
      observationStation: { code: 'yqr', name: "Regina Int'l Airport" },
      windSpeedKmh: 15,
      windGustKmh: 29,
      temperatureCelsius: 23.9,
    },
    ...overrides,
  };
}

describe('RiskScoringService', () => {
  let service: RiskScoringService;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new RiskScoringService();
    // The full-precision breakdown is logged, not returned (see risk-scoring.service.ts) —
    // capture it here so the detailed formula math is still covered by tests.
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function lastLoggedBreakdown(): ViabilityRiskBreakdown {
    const calls = logSpy.mock.calls as unknown as [string][];
    const message = calls.at(-1)?.[0] ?? '';
    return JSON.parse(
      message.slice(message.indexOf('{')),
    ) as ViabilityRiskBreakdown;
  }

  describe('calculateViabilityScore', () => {
    it('returns dataAvailable=false with cacheable=null when soil data is unavailable, and logs why', () => {
      const result = service.calculateViabilityScore(
        { ...reginaSoil(), dataAvailable: false },
        reginaClimate(),
        reginaCurrentConditions(),
      );

      expect(result).toEqual({
        score: {
          dataAvailable: false,
          overallRisk: null,
          shortTermRisk: null,
          longTermRisk: null,
        },
        cacheable: null,
      });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('soil.dataAvailable=false'),
      );
    });

    it('returns dataAvailable=false when climate normals are unavailable', () => {
      const { score } = service.calculateViabilityScore(
        reginaSoil(),
        { ...reginaClimate(), dataAvailable: false, normals: null },
        reginaCurrentConditions(),
      );

      expect(score.dataAvailable).toBe(false);
    });

    it('falls back to longTermRisk alone, but still populates cacheable, when only current conditions are unavailable', () => {
      const { score, cacheable } = service.calculateViabilityScore(
        reginaSoil(),
        reginaClimate(),
        {
          ...reginaCurrentConditions(),
          dataAvailable: false,
          conditions: null,
        },
      );

      // Soil + climate are what longTermRisk needs — current conditions failing
      // alone shouldn't discard a perfectly good structural score, and shouldn't
      // block caching it either (this is the fix for the "a location can never be
      // cached just because citypageweather has no nearby city point" gap).
      expect(score.dataAvailable).toBe(true);
      expect(score.shortTermRisk).toBeNull();
      expect(score.longTermRisk).not.toBeNull();
      expect(score.overallRisk).toBe(score.longTermRisk);
      expect(cacheable).not.toBeNull();
      expect(cacheable?.longTermRisk).toBeCloseTo(score.longTermRisk!, 2);
    });

    it('returns dataAvailable/overallRisk/shortTermRisk/longTermRisk in the score, not contributingFactors', () => {
      const { score } = service.calculateViabilityScore(
        reginaSoil(),
        reginaClimate(),
        reginaCurrentConditions(),
      );

      expect(Object.keys(score).sort()).toEqual([
        'dataAvailable',
        'longTermRisk',
        'overallRisk',
        'shortTermRisk',
      ]);
    });

    it('returns cacheable state matching the logged breakdown, for a future cache hit', () => {
      const { cacheable } = service.calculateViabilityScore(
        reginaSoil(),
        reginaClimate(),
        reginaCurrentConditions(),
      );
      const breakdown = lastLoggedBreakdown();

      expect(cacheable).toEqual({
        longTermRisk: breakdown.longTermRisk,
        soilWetnessRisk: breakdown.contributingFactors.longTerm.soilWetnessRisk,
        meanWindSpeedKmh: 18.42,
      });
    });

    it('rounds overallRisk to 2 decimal places for display, while the logged value retains full precision', () => {
      const { score } = service.calculateViabilityScore(
        reginaSoil(),
        reginaClimate(),
        reginaCurrentConditions(),
      );
      const breakdown = lastLoggedBreakdown();

      expect(score.overallRisk).toBe(
        Math.round(score.overallRisk! * 100) / 100,
      );
      expect(breakdown.overallRisk).not.toBe(score.overallRisk);
      expect(breakdown.overallRisk).toBeCloseTo(score.overallRisk!, 1);
    });

    it('computes a plausible low-moderate risk for Regina on a calm, well-drained summer day', () => {
      const { score } = service.calculateViabilityScore(
        reginaSoil(),
        reginaClimate(),
        reginaCurrentConditions(),
      );
      const breakdown = lastLoggedBreakdown();

      expect(score.dataAvailable).toBe(true);
      // Deep soil (depth class 5), well-drained, low slope, moderate wind/freeze-thaw normals,
      // calm well-above-freezing conditions -> a real but unremarkable risk level.
      expect(breakdown.longTermRisk).toBeGreaterThan(0.1);
      expect(breakdown.longTermRisk).toBeLessThan(0.3);
      expect(breakdown.shortTermRisk).toBeGreaterThanOrEqual(0);
      expect(breakdown.shortTermRisk).toBeLessThan(0.3);
      expect(breakdown.overallRisk).toBeGreaterThanOrEqual(
        breakdown.longTermRisk,
      );
      // footingDepthRisk = average(depthClassRisk=0, bulkDensityRisk for BD=1.2 g/cm3 ~= 0.571) = ~0.286.
      // Not 0: depth class 5 alone is "good," but BD=1.2 is only moderately dense, not maximally so.
      expect(
        breakdown.contributingFactors.longTerm.footingDepthRisk,
      ).toBeCloseTo(0.286, 2);
    });

    it('every risk field stays within [0, 1] regardless of how extreme the inputs are', () => {
      const { score } = service.calculateViabilityScore(
        reginaSoil({
          depthToRestriction: { depthClass: '1', restrictionType: 'LI' },
          drainage: { kind: 'O', drainageClass: 'VP', waterTableClass: 'YB' },
          layers: [
            {
              layerNo: 1,
              upperDepthCm: 0,
              lowerDepthCm: 20,
              bulkDensity: 0.5,
              sandPercent: 5,
              siltPercent: 15,
              clayPercent: 80,
              saturatedHydraulicConductivity: 0.01,
            },
          ],
          landform: {
            slopePercent: 60,
            slopeSegmentPercent: 100,
            name: 'Steep',
          },
        }),
        reginaClimate({
          normals: {
            meanWindSpeedKmh: 60,
            highWindDaysPerYear: 200,
            totalPrecipitationMm: 3000,
            frostFreePeriodDays: 10,
            degreeDaysBelowZero: 6000,
          },
        }),
        reginaCurrentConditions({
          conditions: {
            observedAt: '2026-01-10T16:00:00Z',
            observationStation: { code: 'yqr', name: "Regina Int'l Airport" },
            windSpeedKmh: 150,
            windGustKmh: 220,
            temperatureCelsius: 0,
          },
        }),
      );
      const breakdown = lastLoggedBreakdown();

      for (const value of [
        breakdown.longTermRisk,
        breakdown.shortTermRisk,
        breakdown.overallRisk,
      ]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      // Worst-case inputs across the board should read as near-maximum risk, not just "elevated".
      expect(breakdown.longTermRisk).toBeGreaterThan(0.85);
      expect(score.overallRisk).toBe(1);
    });

    it('gives organic soil a strictly higher long-term risk than otherwise-identical mineral soil', () => {
      service.calculateViabilityScore(
        reginaSoil(),
        reginaClimate(),
        reginaCurrentConditions(),
      );
      const mineral = lastLoggedBreakdown();

      service.calculateViabilityScore(
        reginaSoil({
          drainage: { kind: 'O', drainageClass: 'W', waterTableClass: 'NO' },
        }),
        reginaClimate(),
        reginaCurrentConditions(),
      );
      const organic = lastLoggedBreakdown();

      expect(organic.longTermRisk).toBeGreaterThan(mineral.longTermRisk);
      expect(organic.contributingFactors.longTerm.organicSoilRisk).toBeCloseTo(
        0.3,
        5,
      );
      expect(mineral.contributingFactors.longTerm.organicSoilRisk).toBe(0);
    });

    it('gives a shallow footing (depth class 1) strictly higher long-term risk than a deep one', () => {
      service.calculateViabilityScore(
        reginaSoil(),
        reginaClimate(),
        reginaCurrentConditions(),
      );
      const deep = lastLoggedBreakdown();

      service.calculateViabilityScore(
        reginaSoil({
          depthToRestriction: { depthClass: '1', restrictionType: 'LI' },
        }),
        reginaClimate(),
        reginaCurrentConditions(),
      );
      const shallow = lastLoggedBreakdown();

      expect(shallow.longTermRisk).toBeGreaterThan(deep.longTermRisk);
      // average(depthClassRisk=1, bulkDensityRisk for BD=1.2 g/cm3 ~= 0.571) = ~0.786, not 1 -
      // BD now tempers a "worst case" depth class rather than depth class alone being definitive.
      expect(shallow.contributingFactors.longTerm.footingDepthRisk).toBeCloseTo(
        0.786,
        2,
      );
    });

    it('gives loose soil (low bulk density) a strictly higher footing-depth risk than dense soil, holding depth class constant', () => {
      service.calculateViabilityScore(
        reginaSoil({
          layers: [
            {
              layerNo: 1,
              upperDepthCm: 0,
              lowerDepthCm: 13,
              bulkDensity: 1.6,
              sandPercent: 8,
              siltPercent: 30,
              clayPercent: 62,
              saturatedHydraulicConductivity: 0.34,
            },
          ],
        }),
        reginaClimate(),
        reginaCurrentConditions(),
      );
      const dense = lastLoggedBreakdown();

      service.calculateViabilityScore(
        reginaSoil({
          layers: [
            {
              layerNo: 1,
              upperDepthCm: 0,
              lowerDepthCm: 13,
              bulkDensity: 0.9,
              sandPercent: 8,
              siltPercent: 30,
              clayPercent: 62,
              saturatedHydraulicConductivity: 0.34,
            },
          ],
        }),
        reginaClimate(),
        reginaCurrentConditions(),
      );
      const loose = lastLoggedBreakdown();

      expect(
        loose.contributingFactors.longTerm.bulkDensityRisk,
      ).toBeGreaterThan(dense.contributingFactors.longTerm.bulkDensityRisk);
      expect(dense.contributingFactors.longTerm.bulkDensityRisk).toBeCloseTo(
        0,
        5,
      );
      expect(
        loose.contributingFactors.longTerm.footingDepthRisk,
      ).toBeGreaterThan(dense.contributingFactors.longTerm.footingDepthRisk);
    });

    it('gives a wind gust far above normal a strictly higher short-term risk than calm conditions', () => {
      const { score: calm } = service.calculateViabilityScore(
        reginaSoil(),
        reginaClimate(),
        reginaCurrentConditions(),
      );
      const { score: gusty } = service.calculateViabilityScore(
        reginaSoil(),
        reginaClimate(),
        reginaCurrentConditions({
          conditions: {
            observedAt: '2026-07-10T16:00:00Z',
            observationStation: { code: 'yqr', name: "Regina Int'l Airport" },
            windSpeedKmh: 40,
            windGustKmh: 90,
            temperatureCelsius: 23.9,
          },
        }),
      );

      expect(gusty.overallRisk).toBeGreaterThan(calm.overallRisk!);
    });

    it('peaks freeze-thaw transition risk when current temperature is exactly 0°C on wet soil', () => {
      const wetSoil = reginaSoil({
        drainage: { kind: 'M', drainageClass: 'VP', waterTableClass: 'YB' },
      });

      service.calculateViabilityScore(
        wetSoil,
        reginaClimate(),
        reginaCurrentConditions({
          conditions: {
            observedAt: '2026-01-10T16:00:00Z',
            observationStation: { code: 'yqr', name: "Regina Int'l Airport" },
            windSpeedKmh: 5,
            windGustKmh: 8,
            temperatureCelsius: 0,
          },
        }),
      );
      const atFreezing = lastLoggedBreakdown();

      service.calculateViabilityScore(
        wetSoil,
        reginaClimate(),
        reginaCurrentConditions({
          conditions: {
            observedAt: '2026-07-10T16:00:00Z',
            observationStation: { code: 'yqr', name: "Regina Int'l Airport" },
            windSpeedKmh: 5,
            windGustKmh: 8,
            temperatureCelsius: 25,
          },
        }),
      );
      const wellAboveFreezing = lastLoggedBreakdown();

      expect(
        atFreezing.contributingFactors.shortTerm.freezeThawTransitionRisk,
      ).toBeGreaterThan(
        wellAboveFreezing.contributingFactors.shortTerm
          .freezeThawTransitionRisk,
      );
    });

    it('handles missing optional sub-fields (no layers, no landform, no depth/drainage) without throwing', () => {
      const { score } = service.calculateViabilityScore(
        reginaSoil({
          component: null,
          depthToRestriction: null,
          drainage: null,
          layers: [],
          landform: null,
        }),
        reginaClimate(),
        reginaCurrentConditions(),
      );

      expect(score.dataAvailable).toBe(true);
      expect(Number.isFinite(score.overallRisk)).toBe(true);
      expect(score.overallRisk).toBeGreaterThanOrEqual(0);
      expect(score.overallRisk).toBeLessThanOrEqual(1);
    });
  });

  describe('calculateShortTermRiskOnly', () => {
    const cached: CacheableLongTermRisk = {
      longTermRisk: 0.2421148355113637,
      soilWetnessRisk: 0.11625,
      meanWindSpeedKmh: 18.42,
    };

    it('reuses the cached longTermRisk unchanged, rounded, rather than recomputing it', () => {
      const score = service.calculateShortTermRiskOnly(
        reginaCurrentConditions(),
        cached,
      );

      expect(score.longTermRisk).toBe(
        Math.round(cached.longTermRisk * 100) / 100,
      );
    });

    it('produces the same shortTermRisk as a full computation with equivalent inputs', () => {
      const { score: full } = service.calculateViabilityScore(
        reginaSoil(),
        reginaClimate(),
        reginaCurrentConditions(),
      );
      const cacheHit = service.calculateShortTermRiskOnly(
        reginaCurrentConditions(),
        cached,
      );

      expect(cacheHit.shortTermRisk).toBe(full.shortTermRisk);
      expect(cacheHit.overallRisk).toBe(full.overallRisk);
    });

    it('reacts to fresh live conditions even though longTermRisk is reused', () => {
      const calm = service.calculateShortTermRiskOnly(
        reginaCurrentConditions(),
        cached,
      );
      const gusty = service.calculateShortTermRiskOnly(
        reginaCurrentConditions({
          conditions: {
            observedAt: '2026-07-10T16:00:00Z',
            observationStation: { code: 'yqr', name: "Regina Int'l Airport" },
            windSpeedKmh: 40,
            windGustKmh: 90,
            temperatureCelsius: 23.9,
          },
        }),
        cached,
      );

      expect(gusty.shortTermRisk).toBeGreaterThan(calm.shortTermRisk!);
      expect(gusty.longTermRisk).toBe(calm.longTermRisk);
    });

    it('falls back to the cached longTermRisk alone when current conditions are unavailable, rather than nulling everything out', () => {
      const score = service.calculateShortTermRiskOnly(
        {
          ...reginaCurrentConditions(),
          dataAvailable: false,
          conditions: null,
        },
        cached,
      );

      // The cache hit already proved longTermRisk is valid — a momentary live
      // conditions failure shouldn't throw that away (mirrors the equivalent
      // branch in calculateViabilityScore).
      expect(score).toEqual({
        dataAvailable: true,
        overallRisk: Math.round(cached.longTermRisk * 100) / 100,
        shortTermRisk: null,
        longTermRisk: Math.round(cached.longTermRisk * 100) / 100,
      });
    });
  });
});

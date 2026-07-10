import { Injectable, Logger } from '@nestjs/common';
import { SoilService } from '../soil/soil.service';
import { ClimateService } from '../climate/climate.service';
import { RiskScoringService } from '../scoring/risk-scoring.service';
import { PoleViabilityScore } from '../scoring/interfaces/pole-viability-score.interface';
import { ScoreCacheRepository } from '../score-cache/score-cache.repository';

/**
 * Orchestrates a full pole viability lookup, with a cache keyed on exact
 * (lat, lng):
 *
 * - **Cache hit**: skip fetching soil and climate normals entirely, reuse
 *   the stored `longTermRisk` (soil/30-year-normals are genuinely stable),
 *   but still fetch live current conditions and recompute `shortTermRisk`
 *   fresh — a repeat query should never return day-old wind/temperature
 *   data. The cache row's `shortTermRisk`/`overallRisk` are updated
 *   afterward either way.
 * - **Cache miss**: fetch all three inputs, compute the full score, and
 *   store it for next time — as long as soil + climate normals resolved
 *   (`cacheable` is non-null); a momentary current-conditions failure alone
 *   doesn't block caching, since `longTermRisk` never depended on it.
 *
 * `GET /viability` returns only the score — the raw input profiles are
 * logged (here and in `RiskScoringService`), not returned. See README.md
 * "Scoring formula" > Logging.
 */
@Injectable()
export class PoleViabilityService {
  private readonly logger = new Logger(PoleViabilityService.name);

  constructor(
    private readonly soilService: SoilService,
    private readonly climateService: ClimateService,
    private readonly riskScoringService: RiskScoringService,
    private readonly scoreCacheRepository: ScoreCacheRepository,
  ) {}

  async getViabilityAssessment(
    lat: number,
    lng: number,
  ): Promise<PoleViabilityScore> {
    const cached = this.scoreCacheRepository.findByLocation(lat, lng);
    if (cached) {
      return this.recomputeFromCache(
        lat,
        lng,
        cached.longTermRisk,
        cached.soilWetnessRisk,
        cached.meanWindSpeedKmh,
      );
    }
    return this.computeFresh(lat, lng);
  }

  private async recomputeFromCache(
    lat: number,
    lng: number,
    longTermRisk: number,
    soilWetnessRisk: number,
    meanWindSpeedKmh: number | null,
  ): Promise<PoleViabilityScore> {
    const currentConditions = await this.climateService.getCurrentConditions(
      lat,
      lng,
    );

    const score = this.riskScoringService.calculateShortTermRiskOnly(
      currentConditions,
      {
        longTermRisk,
        soilWetnessRisk,
        meanWindSpeedKmh,
      },
    );

    // score.dataAvailable is always true here (a cache hit means longTermRisk is
    // already known), so check shortTermRisk itself to know whether this request
    // actually got a fresh live reading worth persisting — not just "did it succeed."
    if (score.shortTermRisk !== null) {
      this.scoreCacheRepository.updateShortTerm(
        lat,
        lng,
        score.shortTermRisk,
        score.overallRisk!,
      );
    }

    this.logger.log(
      `Cache hit for (${lat}, ${lng}) — reused longTermRisk, recomputed shortTermRisk. ` +
        `currentConditions=${JSON.stringify(currentConditions)}`,
    );

    return score;
  }

  private async computeFresh(
    lat: number,
    lng: number,
  ): Promise<PoleViabilityScore> {
    const [soil, climate, currentConditions] = await Promise.all([
      this.soilService.getSoilRiskProfile(lat, lng),
      this.climateService.getClimateRiskProfile(lat, lng),
      this.climateService.getCurrentConditions(lat, lng),
    ]);

    const { score, cacheable } =
      this.riskScoringService.calculateViabilityScore(
        soil,
        climate,
        currentConditions,
      );

    if (cacheable) {
      // score.overallRisk is always non-null whenever cacheable is non-null (both
      // require only soil+climate, see RiskScoringService.calculateViabilityScore).
      // shortTermRisk can still be null here if current conditions failed on this
      // particular request — 0 means "nothing to add on top of the structural
      // baseline yet," and a future cache-hit request will refresh it once current
      // conditions succeed.
      this.scoreCacheRepository.upsertFullScore({
        lat,
        lng,
        longTermRisk: cacheable.longTermRisk,
        shortTermRisk: score.shortTermRisk ?? 0,
        overallRisk: score.overallRisk!,
        soilWetnessRisk: cacheable.soilWetnessRisk,
        meanWindSpeedKmh: cacheable.meanWindSpeedKmh,
      });
    }

    this.logger.log(
      `Cache miss for (${lat}, ${lng}) — computed fresh. soil=${JSON.stringify(soil)}, ` +
        `climate=${JSON.stringify(climate)}, currentConditions=${JSON.stringify(currentConditions)}`,
    );

    return score;
  }
}

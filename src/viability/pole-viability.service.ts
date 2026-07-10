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
 *   store it for next time (unless `dataAvailable` is false — nothing
 *   meaningful to cache for an out-of-coverage location).
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

    if (score.dataAvailable) {
      this.scoreCacheRepository.updateShortTerm(
        lat,
        lng,
        score.shortTermRisk!,
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
      this.scoreCacheRepository.upsertFullScore({
        lat,
        lng,
        longTermRisk: cacheable.longTermRisk,
        shortTermRisk: score.shortTermRisk!,
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

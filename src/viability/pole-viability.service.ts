import { Injectable, Logger } from '@nestjs/common';
import { SoilService } from '../soil/soil.service';
import { ClimateService } from '../climate/climate.service';
import { RiskScoringService } from '../scoring/risk-scoring.service';
import { PoleViabilityScore } from '../scoring/interfaces/pole-viability-score.interface';

/**
 * Orchestrates a full pole viability lookup: fetches soil, climate normals,
 * and current conditions in parallel, then hands them to
 * `RiskScoringService` (a pure function) to compute the score. Kept
 * separate from `ViabilityController` so the controller stays a thin HTTP
 * adapter and this orchestration logic is unit-testable without HTTP.
 *
 * `GET /viability` returns only the score (`dataAvailable`/`overallRisk`/
 * `shortTermRisk`/`longTermRisk`) — the raw soil/climate/current-conditions
 * profiles that produced it are logged here instead, not returned. This
 * mirrors `RiskScoringService` logging its own full-precision breakdown
 * rather than returning it: the response is for display, the log is for
 * debugging/observability.
 */
@Injectable()
export class PoleViabilityService {
  private readonly logger = new Logger(PoleViabilityService.name);

  constructor(
    private readonly soilService: SoilService,
    private readonly climateService: ClimateService,
    private readonly riskScoringService: RiskScoringService,
  ) {}

  async getViabilityAssessment(
    lat: number,
    lng: number,
  ): Promise<PoleViabilityScore> {
    const [soil, climate, currentConditions] = await Promise.all([
      this.soilService.getSoilRiskProfile(lat, lng),
      this.climateService.getClimateRiskProfile(lat, lng),
      this.climateService.getCurrentConditions(lat, lng),
    ]);

    const score = this.riskScoringService.calculateViabilityScore(
      soil,
      climate,
      currentConditions,
    );

    this.logger.log(
      `Viability inputs for (${lat}, ${lng}): soil=${JSON.stringify(soil)}, ` +
        `climate=${JSON.stringify(climate)}, currentConditions=${JSON.stringify(currentConditions)}`,
    );

    return score;
  }
}

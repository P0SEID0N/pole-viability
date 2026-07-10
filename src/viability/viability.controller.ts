import { Controller, Get, Query } from '@nestjs/common';
import { PoleViabilityService } from './pole-viability.service';
import { GetViabilityQueryDto } from './dto/get-viability-query.dto';
import { PoleViabilityScore } from '../scoring/interfaces/pole-viability-score.interface';

/**
 * The public entry point for pole viability lookups — the one URL the
 * outside world calls. Returns only the computed risk score
 * (`dataAvailable`/`overallRisk`/`shortTermRisk`/`longTermRisk`) — the raw
 * soil/climate/current-conditions inputs are logged, not returned (see
 * `PoleViabilityService`).
 */
@Controller('viability')
export class ViabilityController {
  constructor(private readonly poleViabilityService: PoleViabilityService) {}

  @Get()
  getViability(
    @Query() query: GetViabilityQueryDto,
  ): Promise<PoleViabilityScore> {
    return this.poleViabilityService.getViabilityAssessment(
      query.lat,
      query.lng,
    );
  }
}

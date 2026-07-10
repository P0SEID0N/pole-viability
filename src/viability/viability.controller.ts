import { Controller, Get, Query } from '@nestjs/common';
import { SoilService } from '../soil/soil.service';
import { GetViabilityQueryDto } from './dto/get-viability-query.dto';
import { SoilRiskProfile } from '../soil/interfaces/soil-risk-profile.interface';

/**
 * The public entry point for pole viability lookups. Currently just proxies
 * to `SoilService` and returns its raw soil risk profile — there's no
 * combined score yet. Once the climate service and scoring formula exist,
 * this is where they'll be combined; the soil-only response shape here will
 * very likely change when that happens, since it'll become one input to a
 * larger response rather than the whole thing.
 */
@Controller('viability')
export class ViabilityController {
  constructor(private readonly soilService: SoilService) {}

  @Get()
  getViability(@Query() query: GetViabilityQueryDto): Promise<SoilRiskProfile> {
    return this.soilService.getSoilRiskProfile(query.lat, query.lng);
  }
}

import { Module } from '@nestjs/common';
import { SoilModule } from '../soil/soil.module';
import { ClimateModule } from '../climate/climate.module';
import { ScoringModule } from '../scoring/scoring.module';
import { ViabilityController } from './viability.controller';
import { PoleViabilityService } from './pole-viability.service';

@Module({
  imports: [SoilModule, ClimateModule, ScoringModule],
  controllers: [ViabilityController],
  providers: [PoleViabilityService],
})
export class ViabilityModule {}

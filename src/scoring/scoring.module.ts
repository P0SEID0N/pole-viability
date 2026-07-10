import { Module } from '@nestjs/common';
import { RiskScoringService } from './risk-scoring.service';

@Module({
  providers: [RiskScoringService],
  exports: [RiskScoringService],
})
export class ScoringModule {}

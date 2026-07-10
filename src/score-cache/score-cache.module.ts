import { Module } from '@nestjs/common';
import { ScoreCacheRepository } from './score-cache.repository';

@Module({
  providers: [ScoreCacheRepository],
  exports: [ScoreCacheRepository],
})
export class ScoreCacheModule {}

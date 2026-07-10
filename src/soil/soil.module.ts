import { Module } from '@nestjs/common';
import { SoilService } from './soil.service';
import { SlcDataRepository } from './slc-data.repository';

@Module({
  providers: [SlcDataRepository, SoilService],
  exports: [SoilService],
})
export class SoilModule {}

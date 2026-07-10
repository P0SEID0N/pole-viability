import { Module } from '@nestjs/common';
import { ClimateService } from './climate.service';
import { MscGeometClient } from './msc-geomet.client';

@Module({
  providers: [MscGeometClient, ClimateService],
  exports: [ClimateService],
})
export class ClimateModule {}

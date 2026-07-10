import { Module } from '@nestjs/common';
import { SoilModule } from '../soil/soil.module';
import { ViabilityController } from './viability.controller';

@Module({
  imports: [SoilModule],
  controllers: [ViabilityController],
})
export class ViabilityModule {}

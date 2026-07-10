import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SoilModule } from './soil/soil.module';
import { ClimateModule } from './climate/climate.module';
import { ViabilityModule } from './viability/viability.module';

@Module({
  imports: [SoilModule, ClimateModule, ViabilityModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

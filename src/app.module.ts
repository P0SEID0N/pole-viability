import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SoilModule } from './soil/soil.module';

@Module({
  imports: [SoilModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

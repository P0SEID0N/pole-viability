import { Test } from '@nestjs/testing';
import { SoilModule } from './src/soil/soil.module';
import { SoilService } from './src/soil/soil.service';

async function main() {
  const moduleRef = await Test.createTestingModule({ imports: [SoilModule] }).compile();
  const soilService = moduleRef.get(SoilService);

  const profile = await soilService.getSoilRiskProfile(44.430401, -79.363698);
  console.log('=== Lake Simcoe center (44.430401, -79.363698) ===');
  console.log(JSON.stringify(profile, null, 2));

  await moduleRef.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { Test, TestingModule } from '@nestjs/testing';
import { SoilModule } from './soil.module';
import { SoilService } from './soil.service';

describe('SoilService', () => {
  let soilService: SoilService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [SoilModule],
    }).compile();

    await moduleRef.init();

    soilService = moduleRef.get(SoilService);
  }, 30000);

  it('returns joined soil factors for a known Canadian location (Regina, SK)', async () => {
    const profile = await soilService.getSoilRiskProfile(50.4452, -104.6189);

    expect(profile.dataAvailable).toBe(true);
    expect(profile.polygonId).not.toBeNull();
    expect(profile.component).not.toBeNull();
    expect(profile.component?.soilId).toBeTruthy();
    expect(profile.drainage).not.toBeNull();
  });

  it('returns dataAvailable=false for a point with no SLC coverage (open ocean)', async () => {
    const profile = await soilService.getSoilRiskProfile(45, -40);

    expect(profile.dataAvailable).toBe(false);
    expect(profile.polygonId).toBeNull();
  });
});

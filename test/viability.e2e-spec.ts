import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { SoilRiskProfile } from './../src/soil/interfaces/soil-risk-profile.interface';

describe('ViabilityController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  it('returns the soil risk profile for a known Canadian location (Regina, SK)', async () => {
    const response = await request(app.getHttpServer())
      .get('/viability')
      .query({ lat: 50.4452, lng: -104.6189 })
      .expect(200);

    const profile = response.body as SoilRiskProfile;
    expect(profile.dataAvailable).toBe(true);
    expect(profile.polygonId).not.toBeNull();
    expect(profile.component?.soilName).toBe('REGINA O.V');
  });

  it('rejects a request missing lat/lng with 400', async () => {
    await request(app.getHttpServer()).get('/viability').expect(400);
  });

  it('rejects an out-of-range latitude with 400', async () => {
    await request(app.getHttpServer())
      .get('/viability')
      .query({ lat: 999, lng: -104.6189 })
      .expect(400);
  });
});

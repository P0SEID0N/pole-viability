import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { MscGeometClient } from './../src/climate/msc-geomet.client';
import { PoleViabilityScore } from './../src/scoring/interfaces/pole-viability-score.interface';

/**
 * Mocks MscGeometClient rather than hitting the live MSC GeoMet API — same
 * reasoning as the climate unit tests (see climate.service.spec.ts): slow,
 * flaky, outside our control for CI. Soil still reads the real local
 * landscape_data/ files, same as before — that's static data we control,
 * not a live third-party dependency. This still exercises the real
 * HTTP/validation/DI stack end-to-end, just without the live network call.
 */
const mockMscGeometClient = {
  findNearestNormalsStation: jest.fn().mockResolvedValue({
    climateIdentifier: '4016560',
    name: "REGINA INT'L A",
    distanceKm: 3.6,
  }),
  getAnnualNormals: jest.fn().mockResolvedValue({
    valuesByNormalId: new Map<number, number>([
      [90, 18.42],
      [141, 29.48],
      [56, 389.67],
      [21, 115],
      [28, 1573.16],
    ]),
    period: { begin: 1981, end: 2010 },
  }),
  findNearestCityConditions: jest.fn().mockResolvedValue({
    identifier: 'sk-32',
    name: 'Regina',
    distanceKm: 0.54,
    observedAt: '2026-07-10T16:00:00Z',
    observationStationCode: 'yqr',
    observationStationName: "Regina Int'l Airport",
    windSpeedKmh: 15,
    windGustKmh: 29,
    temperatureCelsius: 23.9,
  }),
};

describe('ViabilityController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    // In-memory score-cache DB — isolated per test run, no file left on disk,
    // and no risk of a later run silently hitting a cache row from an earlier one.
    process.env.SCORE_CACHE_DB_PATH = ':memory:';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MscGeometClient)
      .useValue(mockMscGeometClient)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  it('returns only the risk score for a known Canadian location (Regina, SK) — no raw soil/climate data', async () => {
    const response = await request(app.getHttpServer())
      .get('/viability')
      .query({ lat: 50.4452, lng: -104.6189 })
      .expect(200);

    const score = response.body as PoleViabilityScore;
    expect(Object.keys(score).sort()).toEqual([
      'dataAvailable',
      'longTermRisk',
      'overallRisk',
      'shortTermRisk',
    ]);
    expect(score.dataAvailable).toBe(true);
    for (const value of [
      score.overallRisk,
      score.shortTermRisk,
      score.longTermRisk,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      // Rounded to 2 decimal places for display — the full-precision breakdown is logged, not returned.
      expect(value).toBe(Math.round(value! * 100) / 100);
    }
  });

  it('reuses longTermRisk from the cache on a repeat request, but still refreshes shortTermRisk', async () => {
    const location = { lat: 51.0447, lng: -114.0719 }; // Calgary, AB — distinct from the golden-path test's location
    mockMscGeometClient.findNearestNormalsStation.mockClear();
    mockMscGeometClient.getAnnualNormals.mockClear();
    mockMscGeometClient.findNearestCityConditions.mockClear();

    const first = await request(app.getHttpServer())
      .get('/viability')
      .query(location)
      .expect(200);
    const second = await request(app.getHttpServer())
      .get('/viability')
      .query(location)
      .expect(200);

    // Cache miss then hit: soil/climate-normals resolution only happens once, but
    // live current conditions are fetched fresh on every request either way.
    expect(mockMscGeometClient.findNearestNormalsStation).toHaveBeenCalledTimes(
      1,
    );
    expect(mockMscGeometClient.getAnnualNormals).toHaveBeenCalledTimes(1);
    expect(mockMscGeometClient.findNearestCityConditions).toHaveBeenCalledTimes(
      2,
    );

    const firstScore = first.body as PoleViabilityScore;
    const secondScore = second.body as PoleViabilityScore;
    expect(secondScore.longTermRisk).toBe(firstScore.longTermRisk);
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

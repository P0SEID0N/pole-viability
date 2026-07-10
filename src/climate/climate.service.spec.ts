import { Test, TestingModule } from '@nestjs/testing';
import { ClimateService } from './climate.service';
import {
  MscGeometClient,
  NearestCityConditions,
  NearestStation,
} from './msc-geomet.client';

/**
 * Mocks `MscGeometClient` rather than hitting the real MSC GeoMet API:
 * a live-network test would be slow, flaky (third-party uptime/rate limits
 * out of our control), and non-deterministic in CI. `msc-geomet.client.spec.ts`
 * covers the HTTP/parsing layer against mocked `fetch`; this file covers
 * `ClimateService`'s own logic (element-ID mapping, missing-data handling).
 */
describe('ClimateService', () => {
  let climateService: ClimateService;
  let mscGeometClient: {
    findNearestNormalsStation: jest.Mock;
    getAnnualNormals: jest.Mock;
    findNearestCityConditions: jest.Mock;
  };

  beforeEach(async () => {
    mscGeometClient = {
      findNearestNormalsStation: jest.fn(),
      getAnnualNormals: jest.fn(),
      findNearestCityConditions: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ClimateService,
        { provide: MscGeometClient, useValue: mscGeometClient },
      ],
    }).compile();

    climateService = moduleRef.get(ClimateService);
  });

  it('maps the nearest station and its annual normals into a ClimateRiskProfile', async () => {
    const station: NearestStation = {
      climateIdentifier: '4016560',
      name: "REGINA INT'L A",
      distanceKm: 3.6,
    };
    mscGeometClient.findNearestNormalsStation.mockResolvedValue(station);
    mscGeometClient.getAnnualNormals.mockResolvedValue({
      valuesByNormalId: new Map<number, number>([
        [90, 18.42],
        [141, 29.48],
        [56, 389.67],
        [21, 115],
        [28, 1573.16],
      ]),
      period: { begin: 1981, end: 2010 },
    });

    const profile = await climateService.getClimateRiskProfile(
      50.4452,
      -104.6189,
    );

    expect(profile).toEqual({
      location: { lat: 50.4452, lng: -104.6189 },
      dataAvailable: true,
      station: {
        climateIdentifier: '4016560',
        name: "REGINA INT'L A",
        distanceKm: 3.6,
        normalPeriod: { begin: 1981, end: 2010 },
      },
      normals: {
        meanWindSpeedKmh: 18.42,
        highWindDaysPerYear: 29.48,
        totalPrecipitationMm: 389.67,
        frostFreePeriodDays: 115,
        degreeDaysBelowZero: 1573.16,
      },
    });
  });

  it('returns dataAvailable=false and skips the normals lookup when no station is found', async () => {
    mscGeometClient.findNearestNormalsStation.mockResolvedValue(null);

    const profile = await climateService.getClimateRiskProfile(45, -40);

    expect(profile).toEqual({
      location: { lat: 45, lng: -40 },
      dataAvailable: false,
      station: null,
      normals: null,
    });
    expect(mscGeometClient.getAnnualNormals).not.toHaveBeenCalled();
  });

  it('nulls out any normal element missing from the station response instead of throwing', async () => {
    mscGeometClient.findNearestNormalsStation.mockResolvedValue({
      climateIdentifier: '1234567',
      name: 'PARTIAL STATION',
      distanceKm: 10,
    } satisfies NearestStation);
    mscGeometClient.getAnnualNormals.mockResolvedValue({
      valuesByNormalId: new Map<number, number>([[90, 15]]), // only wind speed on file
      period: { begin: 1981, end: 2010 },
    });

    const profile = await climateService.getClimateRiskProfile(50, -100);

    expect(profile.normals?.meanWindSpeedKmh).toBe(15);
    expect(profile.normals?.totalPrecipitationMm).toBeNull();
    expect(profile.normals?.frostFreePeriodDays).toBeNull();
  });

  describe('getCurrentConditions', () => {
    it('maps the nearest city and its live conditions into a CurrentConditionsProfile', async () => {
      const city: NearestCityConditions = {
        identifier: 'sk-32',
        name: 'Regina',
        distanceKm: 0.54,
        observedAt: '2026-07-10T16:00:00Z',
        observationStationCode: 'yqr',
        observationStationName: "Regina Int'l Airport",
        windSpeedKmh: 15,
        windGustKmh: 29,
        temperatureCelsius: 23.9,
      };
      mscGeometClient.findNearestCityConditions.mockResolvedValue(city);

      const profile = await climateService.getCurrentConditions(
        50.4452,
        -104.6189,
      );

      expect(profile).toEqual({
        location: { lat: 50.4452, lng: -104.6189 },
        dataAvailable: true,
        city: { identifier: 'sk-32', name: 'Regina', distanceKm: 0.54 },
        conditions: {
          observedAt: '2026-07-10T16:00:00Z',
          observationStation: { code: 'yqr', name: "Regina Int'l Airport" },
          windSpeedKmh: 15,
          windGustKmh: 29,
          temperatureCelsius: 23.9,
        },
      });
    });

    it('passes through a null wind gust when conditions are calm', async () => {
      mscGeometClient.findNearestCityConditions.mockResolvedValue({
        identifier: 'sk-32',
        name: 'Regina',
        distanceKm: 0.54,
        observedAt: '2026-07-10T16:00:00Z',
        observationStationCode: 'yqr',
        observationStationName: "Regina Int'l Airport",
        windSpeedKmh: 5,
        windGustKmh: null,
        temperatureCelsius: 10,
      } satisfies NearestCityConditions);

      const profile = await climateService.getCurrentConditions(50, -100);

      expect(profile.conditions?.windGustKmh).toBeNull();
    });

    it('returns dataAvailable=false with no conditions when no city point is found', async () => {
      mscGeometClient.findNearestCityConditions.mockResolvedValue(null);

      const profile = await climateService.getCurrentConditions(45, -40);

      expect(profile).toEqual({
        location: { lat: 45, lng: -40 },
        dataAvailable: false,
        city: null,
        conditions: null,
      });
    });
  });
});

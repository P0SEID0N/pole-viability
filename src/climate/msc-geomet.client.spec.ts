import { MscGeometClient } from './msc-geomet.client';
import {
  CityPageCurrentConditionsProperties,
  CityPageProperties,
  ClimateNormalProperties,
  ClimateStationProperties,
  GeoJsonFeatureCollection,
} from './interfaces/msc-geomet.interface';

/** Mocks `fetch` rather than hitting the real MSC GeoMet API — see the note in climate.service.spec.ts. */
function mockJsonResponse<T>(
  body: T,
  { ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  } as Response;
}

function stationFeature(
  climateIdentifier: string,
  name: string,
  lng: number,
  lat: number,
): {
  properties: ClimateStationProperties;
  geometry: { type: 'Point'; coordinates: [number, number] };
} {
  return {
    properties: { CLIMATE_IDENTIFIER: climateIdentifier, STATION_NAME: name },
    geometry: { type: 'Point', coordinates: [lng, lat] },
  };
}

function currentConditions(
  overrides: Partial<CityPageCurrentConditionsProperties> = {},
): CityPageCurrentConditionsProperties {
  return {
    timestamp: { en: '2026-07-10T16:00:00Z' },
    wind: {
      speed: { value: { en: 15 } },
      gust: { value: { en: 29 } },
    },
    temperature: { value: { en: 23.9 } },
    station: {
      code: { en: 'yqr' },
      value: { en: "Regina Int'l Airport" },
    },
    ...overrides,
  };
}

function cityFeature(
  identifier: string,
  name: string,
  lng: number,
  lat: number,
  conditions: CityPageCurrentConditionsProperties = currentConditions(),
): {
  properties: CityPageProperties;
  geometry: { type: 'Point'; coordinates: [number, number] };
} {
  return {
    properties: {
      identifier,
      name: { en: name },
      currentConditions: conditions,
    },
    geometry: { type: 'Point', coordinates: [lng, lat] },
  };
}

describe('MscGeometClient', () => {
  let client: MscGeometClient;
  let fetchMock: jest.Mock<Promise<Response>, [URL]>;

  beforeEach(() => {
    client = new MscGeometClient();
    fetchMock = jest.fn<Promise<Response>, [URL]>();
    global.fetch = fetchMock;
  });

  describe('findNearestNormalsStation', () => {
    it('requests HAS_NORMALS_DATA=Y and picks the closest of the returned candidates', async () => {
      const body: GeoJsonFeatureCollection<ClimateStationProperties> = {
        features: [
          stationFeature('A', 'Far Station', -104.5, 51.0),
          stationFeature('B', 'Near Station', -104.62, 50.45),
        ],
      };
      fetchMock.mockResolvedValueOnce(mockJsonResponse(body));

      const station = await client.findNearestNormalsStation(
        50.4452,
        -104.6189,
      );

      expect(station?.climateIdentifier).toBe('B');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const requestedUrl = fetchMock.mock.calls[0][0];
      expect(requestedUrl.pathname).toBe('/collections/climate-stations/items');
      expect(requestedUrl.searchParams.get('HAS_NORMALS_DATA')).toBe('Y');
    });

    it('widens the search box when the first attempt finds no candidates', async () => {
      const empty: GeoJsonFeatureCollection<ClimateStationProperties> = {
        features: [],
      };
      const found: GeoJsonFeatureCollection<ClimateStationProperties> = {
        features: [stationFeature('C', 'Eventually Found', -104.6, 50.4)],
      };
      fetchMock
        .mockResolvedValueOnce(mockJsonResponse(empty))
        .mockResolvedValueOnce(mockJsonResponse(found));

      const station = await client.findNearestNormalsStation(
        50.4452,
        -104.6189,
      );

      expect(station?.climateIdentifier).toBe('C');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns null after exhausting every search width with no candidates', async () => {
      fetchMock.mockResolvedValue(
        mockJsonResponse<GeoJsonFeatureCollection<ClimateStationProperties>>({
          features: [],
        }),
      );

      const station = await client.findNearestNormalsStation(45, -40);

      expect(station).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('throws a clear error when the API responds with a non-ok status', async () => {
      fetchMock.mockResolvedValueOnce(
        mockJsonResponse({}, { ok: false, status: 503 }),
      );

      await expect(
        client.findNearestNormalsStation(50.4452, -104.6189),
      ).rejects.toThrow(/503/);
    });
  });

  describe('getAnnualNormals', () => {
    it('requests MONTH=13 for the given station and maps rows by NORMAL_ID', async () => {
      const body: GeoJsonFeatureCollection<ClimateNormalProperties> = {
        features: [
          {
            properties: {
              NORMAL_ID: 90,
              VALUE: 18.42,
              PERIOD_BEGIN: 1981,
              PERIOD_END: 2010,
            },
            geometry: { type: 'Point', coordinates: [-104.6, 50.4] },
          },
          {
            properties: {
              NORMAL_ID: 56,
              VALUE: 389.67,
              PERIOD_BEGIN: 1981,
              PERIOD_END: 2010,
            },
            geometry: { type: 'Point', coordinates: [-104.6, 50.4] },
          },
        ],
      };
      fetchMock.mockResolvedValueOnce(mockJsonResponse(body));

      const { valuesByNormalId, period } =
        await client.getAnnualNormals('4016560');

      expect(valuesByNormalId.get(90)).toBe(18.42);
      expect(valuesByNormalId.get(56)).toBe(389.67);
      expect(period).toEqual({ begin: 1981, end: 2010 });

      const requestedUrl = fetchMock.mock.calls[0][0];
      expect(requestedUrl.searchParams.get('MONTH')).toBe('13');
      expect(requestedUrl.searchParams.get('CLIMATE_IDENTIFIER')).toBe(
        '4016560',
      );
    });

    it('returns a null period when the station has no annual normals on file', async () => {
      fetchMock.mockResolvedValueOnce(
        mockJsonResponse<GeoJsonFeatureCollection<ClimateNormalProperties>>({
          features: [],
        }),
      );

      const { valuesByNormalId, period } =
        await client.getAnnualNormals('0000000');

      expect(valuesByNormalId.size).toBe(0);
      expect(period).toBeNull();
    });
  });

  describe('findNearestCityConditions', () => {
    it('picks the closest city and maps its current conditions', async () => {
      const body: GeoJsonFeatureCollection<CityPageProperties> = {
        features: [
          cityFeature('sk-1', 'Far City', -104.5, 51.0),
          cityFeature('sk-32', 'Regina', -104.62, 50.45),
        ],
      };
      fetchMock.mockResolvedValueOnce(mockJsonResponse(body));

      const city = await client.findNearestCityConditions(50.4452, -104.6189);

      expect(city?.identifier).toBe('sk-32');
      expect(city?.windSpeedKmh).toBe(15);
      expect(city?.windGustKmh).toBe(29);
      expect(city?.temperatureCelsius).toBe(23.9);
      expect(city?.observationStationCode).toBe('yqr');
      const requestedUrl = fetchMock.mock.calls[0][0];
      expect(requestedUrl.pathname).toBe(
        '/collections/citypageweather-realtime/items',
      );
    });

    it('returns a null wind gust when EC reports none (calm conditions)', async () => {
      const body: GeoJsonFeatureCollection<CityPageProperties> = {
        features: [
          cityFeature(
            'sk-32',
            'Regina',
            -104.62,
            50.45,
            currentConditions({ wind: { speed: { value: { en: 5 } } } }),
          ),
        ],
      };
      fetchMock.mockResolvedValueOnce(mockJsonResponse(body));

      const city = await client.findNearestCityConditions(50.4452, -104.6189);

      expect(city?.windSpeedKmh).toBe(5);
      expect(city?.windGustKmh).toBeNull();
    });

    it('returns null after exhausting every search width with no city point found', async () => {
      fetchMock.mockResolvedValue(
        mockJsonResponse<GeoJsonFeatureCollection<CityPageProperties>>({
          features: [],
        }),
      );

      const city = await client.findNearestCityConditions(45, -40);

      expect(city).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});

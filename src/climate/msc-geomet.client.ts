import { Injectable } from '@nestjs/common';
import {
  CityPageProperties,
  ClimateNormalProperties,
  ClimateStationProperties,
  GeoJsonFeatureCollection,
} from './interfaces/msc-geomet.interface';
import { haversineDistanceKm } from './utils/haversine.util';

const BASE_URL = 'https://api.weather.gc.ca';

/** MONTH=13 is this API's convention for "annual aggregate" rather than a specific month. */
const ANNUAL_MONTH = 13;

/**
 * Progressively wider search boxes (half-width in degrees) tried when
 * looking for a nearby reference point — a normals-reporting station or a
 * citypageweather city. Both are sparse subsets of all possible locations,
 * so a narrow box can easily come back empty in less populated areas — this
 * widens the search instead of giving up after one attempt. Plain degrees
 * rather than a proper geodesic buffer: close enough for "find something
 * nearby" at the point density this API has, not worth the extra complexity
 * for a v1.
 */
const SEARCH_BOX_HALF_WIDTHS_DEGREES = [1, 3, 8];

export interface NearestStation {
  climateIdentifier: string;
  name: string;
  distanceKm: number;
}

export interface NearestCityConditions {
  identifier: string;
  name: string;
  distanceKm: number;
  observedAt: string;
  observationStationCode: string;
  observationStationName: string;
  windSpeedKmh: number;
  windGustKmh: number | null;
  temperatureCelsius: number;
}

interface WithDistance {
  distanceKm: number;
}

/**
 * Thin HTTP client for the MSC GeoMet API (Environment Canada's live
 * climate data service — see README.md "Climate data"). Unlike
 * `SlcDataRepository`, this does no bulk loading: every call is a live
 * request for exactly the data one profile lookup needs, since this is a
 * real-time API rather than a static file dump.
 */
@Injectable()
export class MscGeometClient {
  /**
   * Finds the nearest station that reports 30-year climate normals. Returns
   * `null` rather than throwing if none is found even at the widest search
   * box — that's a legitimate "no data here" answer, not a failure.
   *
   * @param lat - Latitude in decimal degrees.
   * @param lng - Longitude in decimal degrees.
   */
  async findNearestNormalsStation(
    lat: number,
    lng: number,
  ): Promise<NearestStation | null> {
    return this.searchWidening(lat, lng, (bbox) =>
      this.fetchNormalsStationsInBbox(bbox, lat, lng),
    );
  }

  /**
   * Finds the nearest citypageweather-realtime city point and returns its
   * live current conditions (wind, temperature). Returns `null` if no city
   * point is found even at the widest search box.
   *
   * @param lat - Latitude in decimal degrees.
   * @param lng - Longitude in decimal degrees.
   */
  async findNearestCityConditions(
    lat: number,
    lng: number,
  ): Promise<NearestCityConditions | null> {
    return this.searchWidening(lat, lng, (bbox) =>
      this.fetchCityConditionsInBbox(bbox, lat, lng),
    );
  }

  /**
   * Fetches every annual (`MONTH=13`) normal value on file for a station,
   * keyed by `NORMAL_ID`. Deliberately fetches the whole annual set in one
   * request rather than one request per element (~97 rows for a typical
   * station, well within one page) — `ClimateService` picks out just the
   * handful of element IDs it cares about from the result. The API doesn't
   * support filtering `NORMAL_ID` to a list in one call, so fetching
   * everything and filtering client-side is actually the simpler and
   * cheaper option here, not a shortcut.
   *
   * @param climateIdentifier - The station's `CLIMATE_IDENTIFIER`.
   * @returns Map of `NORMAL_ID` to that element's annual value, plus the
   *   normal period (e.g. 1981-2010) read off the first row.
   */
  async getAnnualNormals(climateIdentifier: string): Promise<{
    valuesByNormalId: Map<number, number>;
    period: { begin: number; end: number } | null;
  }> {
    const url = new URL(`${BASE_URL}/collections/climate-normals/items`);
    url.searchParams.set('CLIMATE_IDENTIFIER', climateIdentifier);
    url.searchParams.set('MONTH', String(ANNUAL_MONTH));
    url.searchParams.set('f', 'json');
    url.searchParams.set('limit', '200');

    const data =
      await this.fetchJson<GeoJsonFeatureCollection<ClimateNormalProperties>>(
        url,
      );

    const valuesByNormalId = new Map<number, number>();
    let period: { begin: number; end: number } | null = null;
    for (const feature of data.features) {
      valuesByNormalId.set(
        feature.properties.NORMAL_ID,
        feature.properties.VALUE,
      );
      period ??= {
        begin: feature.properties.PERIOD_BEGIN,
        end: feature.properties.PERIOD_END,
      };
    }
    return { valuesByNormalId, period };
  }

  /**
   * Shared "widen the bounding box until something turns up, then keep the
   * closest candidate" logic behind `findNearestNormalsStation` and
   * `findNearestCityConditions` — the two collections have unrelated
   * response shapes, but the same search strategy applies to both.
   */
  private async searchWidening<T extends WithDistance>(
    lat: number,
    lng: number,
    fetchCandidatesInBbox: (bbox: string) => Promise<T[]>,
  ): Promise<T | null> {
    for (const halfWidth of SEARCH_BOX_HALF_WIDTHS_DEGREES) {
      const bbox = [
        lng - halfWidth,
        lat - halfWidth,
        lng + halfWidth,
        lat + halfWidth,
      ].join(',');
      const candidates = await fetchCandidatesInBbox(bbox);
      if (candidates.length > 0) {
        return candidates.reduce((nearest, candidate) =>
          candidate.distanceKm < nearest.distanceKm ? candidate : nearest,
        );
      }
    }
    return null;
  }

  private async fetchNormalsStationsInBbox(
    bbox: string,
    lat: number,
    lng: number,
  ): Promise<NearestStation[]> {
    const url = new URL(`${BASE_URL}/collections/climate-stations/items`);
    url.searchParams.set('bbox', bbox);
    // Only stations that actually report 30-year normals — most stations don't.
    url.searchParams.set('HAS_NORMALS_DATA', 'Y');
    url.searchParams.set('f', 'json');
    url.searchParams.set('limit', '50');

    const data =
      await this.fetchJson<GeoJsonFeatureCollection<ClimateStationProperties>>(
        url,
      );

    return data.features.map((feature) => ({
      climateIdentifier: feature.properties.CLIMATE_IDENTIFIER,
      name: feature.properties.STATION_NAME,
      distanceKm: haversineDistanceKm(
        lat,
        lng,
        feature.geometry.coordinates[1],
        feature.geometry.coordinates[0],
      ),
    }));
  }

  private async fetchCityConditionsInBbox(
    bbox: string,
    lat: number,
    lng: number,
  ): Promise<NearestCityConditions[]> {
    const url = new URL(
      `${BASE_URL}/collections/citypageweather-realtime/items`,
    );
    url.searchParams.set('bbox', bbox);
    url.searchParams.set('f', 'json');
    url.searchParams.set('limit', '50');

    const data =
      await this.fetchJson<GeoJsonFeatureCollection<CityPageProperties>>(url);

    return data.features.map((feature) => {
      const conditions = feature.properties.currentConditions;
      return {
        identifier: feature.properties.identifier,
        name: feature.properties.name.en,
        distanceKm: haversineDistanceKm(
          lat,
          lng,
          feature.geometry.coordinates[1],
          feature.geometry.coordinates[0],
        ),
        observedAt: conditions.timestamp.en,
        observationStationCode: conditions.station.code.en,
        observationStationName: conditions.station.value.en,
        windSpeedKmh: conditions.wind.speed.value.en,
        windGustKmh: conditions.wind.gust?.value.en ?? null,
        temperatureCelsius: conditions.temperature.value.en,
      };
    });
  }

  private async fetchJson<T>(url: URL): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `MSC GeoMet request failed: ${response.status} ${response.statusText} (${url.toString()})`,
      );
    }
    return response.json() as Promise<T>;
  }
}

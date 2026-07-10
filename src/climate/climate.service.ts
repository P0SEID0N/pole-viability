import { Injectable } from '@nestjs/common';
import { MscGeometClient } from './msc-geomet.client';
import { ClimateRiskProfile } from './interfaces/climate-risk-profile.interface';
import { CurrentConditionsProfile } from './interfaces/current-conditions-profile.interface';

/**
 * The `climate-normals` `NORMAL_ID` values this service reads, out of the
 * ~140 elements the API offers. Chosen for a direct line to pole fall risk;
 * see README.md "Climate data" for why each one was picked and what was
 * left out (e.g. per-threshold wind/precip day counts beyond these, mean
 * temperature alone) to keep this a small, defensible set rather than
 * importing everything the API has.
 */
const NORMAL_ELEMENT_ID = {
  MEAN_WIND_SPEED_KMH: 90,
  HIGH_WIND_DAYS_PER_YEAR: 141,
  TOTAL_PRECIPITATION_MM: 56,
  FROST_FREE_PERIOD_DAYS: 21,
  DEGREE_DAYS_BELOW_ZERO: 28,
} as const;

@Injectable()
export class ClimateService {
  constructor(private readonly geomet: MscGeometClient) {}

  /**
   * Looks up the raw climate risk factors for a location from the nearest
   * MSC GeoMet station with 30-year normals data. Mirrors
   * `SoilService.getSoilRiskProfile`: returns joined, normalized data, not
   * a computed risk score — scoring is a separate, later step.
   *
   * @param lat - Latitude in decimal degrees.
   * @param lng - Longitude in decimal degrees.
   * @returns The climate profile for the location. If no normals-reporting
   *   station is found nearby, `dataAvailable` is `false` and `station`/
   *   `normals` are `null`.
   */
  async getClimateRiskProfile(
    lat: number,
    lng: number,
  ): Promise<ClimateRiskProfile> {
    const station = await this.geomet.findNearestNormalsStation(lat, lng);
    if (!station) {
      return {
        location: { lat, lng },
        dataAvailable: false,
        station: null,
        normals: null,
      };
    }

    const { valuesByNormalId, period } = await this.geomet.getAnnualNormals(
      station.climateIdentifier,
    );

    return {
      location: { lat, lng },
      dataAvailable: true,
      station: {
        climateIdentifier: station.climateIdentifier,
        name: station.name,
        distanceKm: station.distanceKm,
        normalPeriod: period,
      },
      normals: {
        meanWindSpeedKmh:
          valuesByNormalId.get(NORMAL_ELEMENT_ID.MEAN_WIND_SPEED_KMH) ?? null,
        highWindDaysPerYear:
          valuesByNormalId.get(NORMAL_ELEMENT_ID.HIGH_WIND_DAYS_PER_YEAR) ??
          null,
        totalPrecipitationMm:
          valuesByNormalId.get(NORMAL_ELEMENT_ID.TOTAL_PRECIPITATION_MM) ??
          null,
        frostFreePeriodDays:
          valuesByNormalId.get(NORMAL_ELEMENT_ID.FROST_FREE_PERIOD_DAYS) ??
          null,
        degreeDaysBelowZero:
          valuesByNormalId.get(NORMAL_ELEMENT_ID.DEGREE_DAYS_BELOW_ZERO) ??
          null,
      },
    };
  }

  /**
   * Looks up live current weather conditions (wind, temperature) for a
   * location, from the nearest citypageweather-realtime city point.
   * Deliberately separate from `getClimateRiskProfile`: normals are a
   * stable structural baseline, this is a live, time-varying signal that
   * can change hour to hour — see README.md "Climate data" for why these
   * are kept as two distinct calls rather than merged into one profile.
   *
   * An earlier version of this surfaced EC's free-text warnings instead
   * (e.g. "ORANGE WARNING - HEAT"), which needed fragile string-matching to
   * interpret and didn't distinguish pole-relevant hazards from irrelevant
   * ones. This uses the same collection's structured numeric current
   * conditions instead — see README.md "Climate data" for the full
   * reasoning. Live precipitation was investigated too (`swob-realtime`)
   * but deferred: it has real precip fields, but is a much messier raw
   * observation stream (~150 cryptic field names, requires careful
   * datetime/sort handling to get a true "latest" reading) than this
   * collection's clean current-conditions snapshot.
   *
   * @param lat - Latitude in decimal degrees.
   * @param lng - Longitude in decimal degrees.
   * @returns Current conditions from the nearest city. If no city point is
   *   found nearby, `dataAvailable` is `false` and `conditions` is `null`.
   */
  async getCurrentConditions(
    lat: number,
    lng: number,
  ): Promise<CurrentConditionsProfile> {
    const city = await this.geomet.findNearestCityConditions(lat, lng);
    if (!city) {
      return {
        location: { lat, lng },
        dataAvailable: false,
        city: null,
        conditions: null,
      };
    }

    return {
      location: { lat, lng },
      dataAvailable: true,
      city: {
        identifier: city.identifier,
        name: city.name,
        distanceKm: city.distanceKm,
      },
      conditions: {
        observedAt: city.observedAt,
        observationStation: {
          code: city.observationStationCode,
          name: city.observationStationName,
        },
        windSpeedKmh: city.windSpeedKmh,
        windGustKmh: city.windGustKmh,
        temperatureCelsius: city.temperatureCelsius,
      },
    };
  }
}

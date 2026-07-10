/**
 * Minimal typed slices of the MSC GeoMet (api.weather.gc.ca) GeoJSON
 * responses — only the properties `MscGeometClient` actually reads, not a
 * full schema. See README.md "Climate data" for the field catalog this was
 * chosen from.
 */

export interface GeoJsonFeatureCollection<TProperties> {
  features: {
    properties: TProperties;
    geometry: { type: 'Point'; coordinates: [number, number] };
  }[];
}

/** Fields read from the `climate-stations` collection. */
export interface ClimateStationProperties {
  CLIMATE_IDENTIFIER: string;
  STATION_NAME: string;
}

/** Fields read from the `climate-normals` collection (one row per element per period). */
export interface ClimateNormalProperties {
  NORMAL_ID: number;
  VALUE: number;
  PERIOD_BEGIN: number;
  PERIOD_END: number;
}

/**
 * The `currentConditions.wind`/`.temperature` slice of a
 * `citypageweather-realtime` feature. `gust` is absent (not just missing a
 * value) when conditions are calm enough that EC doesn't report one.
 */
export interface CityPageCurrentConditionsProperties {
  timestamp: { en: string };
  wind: {
    speed: { value: { en: number } };
    gust?: { value: { en: number } };
  };
  temperature: { value: { en: number } };
  station: {
    code: { en: string };
    value: { en: string };
  };
}

/**
 * Fields read from the `citypageweather-realtime` collection. This is a
 * much larger nested payload (multi-day forecast, hourly forecast,
 * warnings, sunrise/set) than what we type here — we only read
 * `currentConditions`. Warnings/alerts were deliberately dropped (see
 * README.md "Climate data"): free-text hazard descriptions needing fragile
 * string-matching to interpret, in favour of these structured numeric
 * readings. The full forecast tree remains out of scope for the same
 * "avoid unnecessary complexity" reasoning.
 */
export interface CityPageProperties {
  identifier: string;
  name: { en: string };
  currentConditions: CityPageCurrentConditionsProperties;
}

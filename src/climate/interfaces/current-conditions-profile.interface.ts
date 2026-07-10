/**
 * Live current weather conditions for a location, resolved from the nearest
 * `citypageweather-realtime` city point. Deliberately kept separate from
 * `ClimateRiskProfile`: normals are a stable, cacheable structural baseline
 * ("is this a risky place for a pole"), while this is live and time-varying
 * ("is this pole under elevated load right now") — see README.md
 * "Assumptions"/"Climate data" for why these are treated as distinct
 * signals rather than merged into one profile.
 *
 * Deliberately numeric-only, no free-text fields: an earlier version of
 * this surfaced EC's warnings text (e.g. "ORANGE WARNING - HEAT"), which
 * needed fragile string-matching to interpret and didn't distinguish
 * pole-relevant hazards (wind/rain/ice) from irrelevant ones (heat, air
 * quality). This replaces that with structured numbers instead.
 */
export interface CurrentConditionsProfile {
  location: { lat: number; lng: number };
  /** false when no citypageweather-realtime city point is found near the location. */
  dataAvailable: boolean;
  city: {
    identifier: string;
    name: string;
    /** Straight-line distance from the requested location to this city point. */
    distanceKm: number;
  } | null;
  conditions: {
    /** When this reading was taken (EC's `currentConditions.timestamp`, ISO string). */
    observedAt: string;
    /** The physical station this reading actually came from — may differ from the city point itself. */
    observationStation: { code: string; name: string };
    windSpeedKmh: number;
    /** null when conditions are calm enough that EC doesn't report a gust value. */
    windGustKmh: number | null;
    temperatureCelsius: number;
  } | null;
}

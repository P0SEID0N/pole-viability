/**
 * Raw climate factors for a location, resolved from the nearest MSC GeoMet
 * station with 30-year normals data. Not a risk score — same pattern as
 * `SoilRiskProfile`, this is the input the scoring formula will consume.
 */
export interface ClimateRiskProfile {
  location: { lat: number; lng: number };
  /** false when no normals-reporting station is found near the location. */
  dataAvailable: boolean;
  station: {
    climateIdentifier: string;
    name: string;
    /** Straight-line distance from the requested location to this station. */
    distanceKm: number;
    /** The 30-year period these normals were calculated over, e.g. 1981-2010. */
    normalPeriod: { begin: number; end: number } | null;
  } | null;
  normals: {
    /** Mean of hourly wind speed, km/h — baseline lateral wind load. */
    meanWindSpeedKmh: number | null;
    /** Mean annual count of days with an hourly wind speed >= 28 knots (~52 km/h). */
    highWindDaysPerYear: number | null;
    /** Mean annual total precipitation, mm — moisture load driving soil saturation. */
    totalPrecipitationMm: number | null;
    /** Mean length of the frost-free period, days — proxy for freeze-thaw cycle exposure. */
    frostFreePeriodDays: number | null;
    /** Mean annual degree-days below 0°C — proxy for frost penetration depth/intensity. */
    degreeDaysBelowZero: number | null;
  } | null;
}

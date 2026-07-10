/**
 * Raw soil factors for a location, joined from the dominant SLC polygon
 * component. This is not a risk score — the scoring formula consumes this.
 */
export interface SoilRiskProfile {
  location: { lat: number; lng: number };
  polygonId: number | null;
  /** false when the point falls outside SLC coverage (e.g. ocean, outside Canada). */
  dataAvailable: boolean;
  component: {
    /** Share of the polygon this soil component covers, 0-100. */
    percentOfPolygon: number;
    slopeClass: string | null;
    stoninessClass: string | null;
    soilId: string;
    soilName: string | null;
  } | null;
  depthToRestriction: {
    depthClass: string | null;
    /** e.g. bedrock, hardpan, water table — what limits footing depth. */
    restrictionType: string | null;
    availableWaterHoldingCapacityClass: string | null;
    coarseFragmentClasses: (string | null)[];
  } | null;
  drainage: {
    /** Mineral vs. organic soil. */
    kind: string | null;
    drainageClass: string | null;
    waterTableClass: string | null;
    rootRestriction: string | null;
  } | null;
  layers: {
    layerNo: number;
    upperDepthCm: number | null;
    lowerDepthCm: number | null;
    bulkDensity: number | null;
    sandPercent: number | null;
    siltPercent: number | null;
    clayPercent: number | null;
    organicCarbonPercent: number | null;
    saturatedHydraulicConductivity: number | null;
  }[];
  landform: {
    slopePercent: number | null;
    /** Share of the polygon this landscape segment covers, 0-100. */
    slopeSegmentPercent: number;
    name: string | null;
  } | null;
}

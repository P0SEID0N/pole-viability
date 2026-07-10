/**
 * Normalized (camelCase, sentinel-nulled) records for the SLC tables we parse.
 * Field selection matches the "core tables to parse" list in README.md.
 */

export interface CmpRecord {
  polyId: number;
  cmpId: number;
  percent: number;
  stoninessClass: string | null;
  soilId: string;
}

export interface CrtRecord {
  cmpId: number;
  depthClass: string | null;
  restrictionType: string | null;
}

export interface SntRecord {
  soilId: string;
  soilName: string | null;
  kind: string | null;
  drainageClass: string | null;
  waterTableClass: string | null;
}

export interface SltRecord {
  soilId: string;
  layerNo: number;
  upperDepthCm: number | null;
  lowerDepthCm: number | null;
  bulkDensity: number | null;
  sandPercent: number | null;
  siltPercent: number | null;
  clayPercent: number | null;
  saturatedHydraulicConductivity: number | null;
}

export interface LstRecord {
  polyId: number;
  percent: number;
  lfsId: string;
}

export interface LdtRecord {
  lfsId: string;
  slopePercent: number | null;
  name: string | null;
}

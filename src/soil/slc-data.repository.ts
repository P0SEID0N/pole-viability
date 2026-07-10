import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { join } from 'node:path';
import * as shapefile from 'shapefile';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import {
  CmpRecord,
  CrtRecord,
  LdtRecord,
  LstRecord,
  SltRecord,
  SntRecord,
} from './interfaces/slc-records.interface';
import { numOrNull, strOrNull } from './utils/dbf-value.util';

interface PolygonIndexEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  polyId: number;
}

/**
 * Loads the Soil Landscapes of Canada (SLC) v3.2 shapefile + related dbf
 * tables into memory once at startup and exposes lookups for SoilService.
 * ~12k polygons and their joined tables are small enough to hold in memory
 * for the process lifetime — see README.md "Soil data (SLC)".
 */
@Injectable()
export class SlcDataRepository implements OnModuleInit {
  private readonly logger = new Logger(SlcDataRepository.name);
  private readonly dataDir =
    process.env.SLC_DATA_DIR ?? join(process.cwd(), 'landscape_data');

  private polygonGeometry = new Map<number, Feature<Polygon | MultiPolygon>>();
  /** Bounding boxes for a cheap pre-filter before the exact point-in-polygon test. Plain array + linear
   * scan (~12k entries) rather than a tree index — simple and fast enough at this dataset size, and
   * avoids `rbush` (ESM-only, no CJS build) fighting Jest's CommonJS test runtime. */
  private polygonIndex: PolygonIndexEntry[] = [];
  private componentsByPolyId = new Map<number, CmpRecord[]>();
  private ratingByCmpId = new Map<number, CrtRecord>();
  private soilNameBySoilId = new Map<string, SntRecord>();
  private soilLayersBySoilId = new Map<string, SltRecord[]>();
  private segmentsByPolyId = new Map<number, LstRecord[]>();
  private landformByLfsId = new Map<string, LdtRecord>();

  private ready!: Promise<void>;

  onModuleInit(): Promise<void> {
    this.ready = this.load();
    return this.ready;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Finds the SLC polygon containing a point, or null if outside coverage. */
  findPolygonId(lat: number, lng: number): number | null {
    for (const candidate of this.polygonIndex) {
      if (
        lng < candidate.minX ||
        lng > candidate.maxX ||
        lat < candidate.minY ||
        lat > candidate.maxY
      ) {
        continue;
      }
      const feature = this.polygonGeometry.get(candidate.polyId);
      if (feature && booleanPointInPolygon([lng, lat], feature)) {
        return candidate.polyId;
      }
    }
    return null;
  }

  getDominantComponent(polyId: number): CmpRecord | null {
    return maxByPercent(this.componentsByPolyId.get(polyId));
  }

  getRating(cmpId: number): CrtRecord | null {
    return this.ratingByCmpId.get(cmpId) ?? null;
  }

  getSoilName(soilId: string): SntRecord | null {
    return this.soilNameBySoilId.get(soilId) ?? null;
  }

  getLayers(soilId: string): SltRecord[] {
    return [...(this.soilLayersBySoilId.get(soilId) ?? [])].sort(
      (a, b) => a.layerNo - b.layerNo,
    );
  }

  getDominantLandform(
    polyId: number,
  ): { segment: LstRecord; landform: LdtRecord | null } | null {
    const segment = maxByPercent(this.segmentsByPolyId.get(polyId));
    if (!segment) return null;
    return {
      segment,
      landform: this.landformByLfsId.get(segment.lfsId) ?? null,
    };
  }

  private async load(): Promise<void> {
    const start = Date.now();
    await Promise.all([
      this.loadPolygons(),
      this.loadComponents(),
      this.loadRatings(),
      this.loadSoilNames(),
      this.loadSoilLayers(),
      this.loadSegments(),
      this.loadLandforms(),
    ]);
    this.logger.log(
      `Loaded SLC dataset from ${this.dataDir} in ${Date.now() - start}ms (${this.polygonGeometry.size} polygons)`,
    );
  }

  private async loadPolygons(): Promise<void> {
    const source = await shapefile.open(
      join(this.dataDir, 'ca_all_slc_v3r2.shp'),
      join(this.dataDir, 'ca_all_slc_v3r2.dbf'),
    );
    let result = await source.read();
    while (!result.done) {
      const feature = result.value as Feature<Polygon | MultiPolygon>;
      const polyId = Number(feature.properties?.POLY_ID);
      this.polygonGeometry.set(polyId, feature);
      const [minX, minY, maxX, maxY] = computeBbox(feature.geometry);
      this.polygonIndex.push({ minX, minY, maxX, maxY, polyId });
      result = await source.read();
    }
  }

  private async loadComponents(): Promise<void> {
    for (const row of await this.readDbf('ca_all_slc_v3r2_cmp.dbf')) {
      const record: CmpRecord = {
        polyId: Number(row.POLY_ID),
        cmpId: Number(row.CMP_ID),
        percent: Number(row.PERCENT),
        slopeClass: strOrNull(row.SLOPE),
        stoninessClass: strOrNull(row.STONE),
        soilId: String(row.SOIL_ID),
      };
      pushTo(this.componentsByPolyId, record.polyId, record);
    }
  }

  private async loadRatings(): Promise<void> {
    for (const row of await this.readDbf('ca_all_slc_v3r2_crt.dbf')) {
      const record: CrtRecord = {
        cmpId: Number(row.CMP_ID),
        depthClass: strOrNull(row.DEPTH),
        restrictionType: strOrNull(row.RESTR_TYPE),
        availableWaterHoldingCapacityClass: strOrNull(row.AWHC),
        coarseFragmentClasses: [strOrNull(row.CFRAG1), strOrNull(row.CFRAG2)],
      };
      this.ratingByCmpId.set(record.cmpId, record);
    }
  }

  private async loadSoilNames(): Promise<void> {
    for (const row of await this.readDbf('soil_name_canada_v2r20231107.dbf')) {
      const record: SntRecord = {
        soilId: String(row.SOIL_ID),
        soilName: strOrNull(row.SOILNAME),
        kind: strOrNull(row.KIND),
        drainageClass: strOrNull(row.DRAINAGE),
        waterTableClass: strOrNull(row.WATERTBL),
        rootRestriction: strOrNull(row.ROOTRESTRI),
      };
      this.soilNameBySoilId.set(record.soilId, record);
    }
  }

  private async loadSoilLayers(): Promise<void> {
    for (const row of await this.readDbf('soil_layer_canada_v2r20231108.dbf')) {
      const record: SltRecord = {
        soilId: String(row.SOIL_ID),
        layerNo: Number(row.LAYER_NO),
        upperDepthCm: numOrNull(row.UDEPTH),
        lowerDepthCm: numOrNull(row.LDEPTH),
        bulkDensity: numOrNull(row.BD),
        sandPercent: numOrNull(row.TSAND),
        siltPercent: numOrNull(row.TSILT),
        clayPercent: numOrNull(row.TCLAY),
        organicCarbonPercent: numOrNull(row.ORGCARB),
        saturatedHydraulicConductivity: numOrNull(row.KSAT),
      };
      pushTo(this.soilLayersBySoilId, record.soilId, record);
    }
  }

  private async loadSegments(): Promise<void> {
    for (const row of await this.readDbf('ca_all_slc_v3r2_lst.dbf')) {
      const record: LstRecord = {
        polyId: Number(row.POLY_ID),
        percent: Number(row.PERCENT),
        lfsId: String(row.LFS_ID),
      };
      pushTo(this.segmentsByPolyId, record.polyId, record);
    }
  }

  private async loadLandforms(): Promise<void> {
    for (const row of await this.readDbf('ca_all_slc_v3r2_ldt.dbf')) {
      const record: LdtRecord = {
        lfsId: String(row.LFS_ID),
        slopePercent: numOrNull(row.LFS_SLOPE),
        name: strOrNull(row.LFS_NAME),
      };
      this.landformByLfsId.set(record.lfsId, record);
    }
  }

  private async readDbf(filename: string): Promise<Record<string, unknown>[]> {
    const source = await shapefile.openDbf(join(this.dataDir, filename));
    const rows: Record<string, unknown>[] = [];
    let result = await source.read();
    while (!result.done) {
      rows.push(result.value as Record<string, unknown>);
      result = await source.read();
    }
    return rows;
  }
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

function maxByPercent<T extends { percent: number }>(
  items: T[] | undefined,
): T | null {
  if (!items || items.length === 0) return null;
  return items.reduce((best, item) =>
    item.percent > best.percent ? item : best,
  );
}

function computeBbox(
  geometry: Polygon | MultiPolygon,
): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const visit = (coords: unknown): void => {
    if (typeof (coords as number[])[0] === 'number') {
      const [x, y] = coords as [number, number];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    } else {
      for (const c of coords as unknown[]) visit(c);
    }
  };
  visit(geometry.coordinates);

  return [minX, minY, maxX, maxY];
}

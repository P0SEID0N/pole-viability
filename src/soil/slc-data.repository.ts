import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { join } from 'node:path';
import { access, constants } from 'node:fs/promises';
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
 * Every SLC file this repository reads from `dataDir`. Not committed to git
 * (62MB of binary GIS data — see README.md "Soil data (SLC)"), so a fresh
 * clone won't have it until it's downloaded separately. Kept as one list so
 * `verifyDataFilesExist` and the individual `load*` methods can't drift out
 * of sync with each other.
 */
const REQUIRED_SLC_FILES = [
  'ca_all_slc_v3r2.shp',
  'ca_all_slc_v3r2.dbf',
  'ca_all_slc_v3r2_cmp.dbf',
  'ca_all_slc_v3r2_crt.dbf',
  'ca_all_slc_v3r2_lst.dbf',
  'ca_all_slc_v3r2_ldt.dbf',
  'soil_name_canada_v2r20231107.dbf',
  'soil_layer_canada_v2r20231108.dbf',
] as const;

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

  /**
   * NestJS lifecycle hook: kicks off the full SLC dataset load as soon as
   * this provider is instantiated. Because this returns the load promise,
   * Nest awaits it during application bootstrap — the app won't start
   * accepting requests until the in-memory indices are fully built, so
   * every query the service ever handles can assume the data is ready.
   */
  onModuleInit(): Promise<void> {
    this.ready = this.load();
    return this.ready;
  }

  /**
   * Lets callers (namely `SoilService`) await dataset readiness explicitly,
   * e.g. in tests that construct this repository outside of Nest's normal
   * bootstrap lifecycle where `onModuleInit` still runs but callers may race it.
   */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /**
   * Finds the SLC polygon containing a point, or null if outside coverage.
   *
   * Two-phase lookup for performance: first cheaply reject polygons whose
   * bounding box doesn't contain the point (a handful of numeric comparisons
   * per candidate), then run the more expensive exact point-in-polygon test
   * (which correctly handles multi-ring/multi-part geometry and holes) only
   * against the survivors.
   *
   * @param lat - Latitude in decimal degrees.
   * @param lng - Longitude in decimal degrees.
   * @returns The `POLY_ID` of the containing polygon, or `null` if the point
   *   isn't covered by the SLC dataset (e.g. ocean, outside Canada).
   */
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

  /**
   * Returns the dominant soil component (CMP row) for a polygon — the one
   * covering the largest `PERCENT` of it. A polygon is often a mosaic of
   * multiple soil components; rather than averaging across all of them, we
   * pick a single representative one to keep the returned profile simple.
   * CMP also carries its own coded `SLOPE` class, dropped here: it's a
   * coarser bucketing of the same slope `getDominantLandform` already
   * reports as an actual percentage via the LDT table — no need for both.
   *
   * @param polyId - The SLC polygon's `POLY_ID`.
   * @returns The dominant component, or `null` if the polygon has none on record.
   */
  getDominantComponent(polyId: number): CmpRecord | null {
    return maxByPercent(this.componentsByPolyId.get(polyId));
  }

  /**
   * Looks up the component rating (CRT row) for a soil component — depth to
   * restriction and restriction type (e.g. bedrock, hardpan, water table).
   * CRT also carries `AWHC` (available water holding capacity) and coarse
   * fragment class, both dropped here: `AWHC` is an agronomic irrigation
   * metric with no clear structural-stability signal, and coarse fragments
   * had no clear directional relationship to fall risk either way.
   *
   * @param cmpId - The `CMP_ID` of the soil component (from a `CmpRecord`).
   * @returns The rating record, or `null` if none is on file for this component.
   */
  getRating(cmpId: number): CrtRecord | null {
    return this.ratingByCmpId.get(cmpId) ?? null;
  }

  /**
   * Looks up the soil name record (SNT row) for a soil — its human-readable
   * name, mineral/organic kind, drainage class, and water table class. SNT
   * also carries `ROOTRESTRI` (root restriction), dropped here: it flags the
   * presence of a restrictive layer, which is what CRT's `DEPTH`/
   * `RESTR_TYPE` already tell us (with more detail, from the component
   * rating side) — keeping both would be the same signal twice.
   *
   * @param soilId - The `SOIL_ID` (from a `CmpRecord`).
   * @returns The soil name record, or `null` if none is on file for this soil.
   */
  getSoilName(soilId: string): SntRecord | null {
    return this.soilNameBySoilId.get(soilId) ?? null;
  }

  /**
   * Looks up all depth layers (SLT rows) for a soil, ordered shallowest to
   * deepest. Each layer carries the physical properties most directly tied
   * to bearing capacity and moisture-driven strength loss: bulk density
   * (compaction/bearing proxy), texture (sand/silt/clay — determines
   * cohesion vs. frost/liquefaction behavior), and saturated hydraulic
   * conductivity (how long the soil stays weak after rain). Organic carbon %
   * was dropped from this record — `SntRecord.kind` (mineral vs. organic)
   * already covers the same signal at the resolution the profile needs.
   *
   * @param soilId - The `SOIL_ID` (from a `CmpRecord`).
   * @returns Layers sorted by `layerNo` ascending (an empty array if none exist).
   */
  getLayers(soilId: string): SltRecord[] {
    return [...(this.soilLayersBySoilId.get(soilId) ?? [])].sort(
      (a, b) => a.layerNo - b.layerNo,
    );
  }

  /**
   * Returns the dominant landscape segment (LST row) for a polygon — the one
   * covering the largest `PERCENT` of it — joined with its landform
   * definition (LDT row) to get the actual slope gradient and landform name.
   * Mirrors `getDominantComponent`'s "pick the largest share" strategy.
   *
   * @param polyId - The SLC polygon's `POLY_ID`.
   * @returns The dominant segment and its landform definition (which may
   *   itself be `null` if the `LFS_ID` has no matching LDT row), or `null` if
   *   the polygon has no landscape segments on record.
   */
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

  /**
   * Confirms every file in `REQUIRED_SLC_FILES` exists and is readable
   * before any table load is attempted. `landscape_data/` is gitignored, so
   * a clone of this repo has no SLC data until it's downloaded separately —
   * without this check, a missing directory would surface as a cryptic
   * `ENOENT` thrown from deep inside the `shapefile` library (and,
   * because `load()` fires off all seven table loads concurrently, likely
   * several near-simultaneous copies of it). This turns that into one clear,
   * actionable startup error naming exactly which files are missing and
   * where to get them.
   *
   * @throws {Error} If `dataDir` itself or any required file inside it is
   *   missing/unreadable, listing every missing filename at once.
   */
  private async verifyDataFilesExist(): Promise<void> {
    const missing: string[] = [];
    await Promise.all(
      REQUIRED_SLC_FILES.map(async (filename) => {
        try {
          await access(join(this.dataDir, filename), constants.R_OK);
        } catch {
          missing.push(filename);
        }
      }),
    );

    if (missing.length > 0) {
      throw new Error(
        `SLC soil data not found in "${this.dataDir}". Missing file(s): ${missing.join(', ')}. ` +
          'This dataset is not committed to git (see .gitignore) — download it from Agriculture and ' +
          'Agri-Food Canada (see README.md "Soil data (SLC)") and place it there, or point SLC_DATA_DIR ' +
          'at wherever you have it.',
      );
    }
  }

  /**
   * Loads every SLC table in parallel and logs how long the whole dataset
   * took to load. Each `load*` method populates its own slice of the
   * in-memory indices, so they have no ordering dependency on each other.
   * Verifies all required files exist first so a missing dataset fails fast
   * with one clear error rather than several concurrent cryptic ones.
   */
  private async load(): Promise<void> {
    await this.verifyDataFilesExist();

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

  /**
   * Streams the PAT shapefile (`ca_all_slc_v3r2.shp`/`.dbf`) feature by
   * feature. For each polygon feature, stores its GeoJSON geometry (needed
   * later for the exact point-in-polygon test) and computes+stores its
   * bounding box (needed for the cheap pre-filter in `findPolygonId`).
   */
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

  /**
   * Loads the CMP (component) table, normalizes each row into a `CmpRecord`,
   * and indexes them by `POLY_ID`. A polygon can have several components
   * (each covering a `PERCENT` share of it), so entries accumulate into a
   * list per polygon rather than overwriting each other.
   */
  private async loadComponents(): Promise<void> {
    for (const row of await this.readDbf('ca_all_slc_v3r2_cmp.dbf')) {
      const record: CmpRecord = {
        polyId: Number(row.POLY_ID),
        cmpId: Number(row.CMP_ID),
        percent: Number(row.PERCENT),
        stoninessClass: strOrNull(row.STONE),
        soilId: String(row.SOIL_ID),
      };
      pushTo(this.componentsByPolyId, record.polyId, record);
    }
  }

  /**
   * Loads the CRT (component rating) table, normalizes each row into a
   * `CrtRecord`, and indexes them by `CMP_ID`. Unlike components/layers,
   * this is a strict one-to-one relationship (one rating per component), so
   * entries directly overwrite rather than accumulate into a list.
   */
  private async loadRatings(): Promise<void> {
    for (const row of await this.readDbf('ca_all_slc_v3r2_crt.dbf')) {
      const record: CrtRecord = {
        cmpId: Number(row.CMP_ID),
        depthClass: strOrNull(row.DEPTH),
        restrictionType: strOrNull(row.RESTR_TYPE),
      };
      this.ratingByCmpId.set(record.cmpId, record);
    }
  }

  /**
   * Loads the SNT (soil name) table, normalizes each row into an
   * `SntRecord`, and indexes them by `SOIL_ID`. One row per soil, so
   * entries directly overwrite rather than accumulate into a list.
   */
  private async loadSoilNames(): Promise<void> {
    for (const row of await this.readDbf('soil_name_canada_v2r20231107.dbf')) {
      const record: SntRecord = {
        soilId: String(row.SOIL_ID),
        soilName: strOrNull(row.SOILNAME),
        kind: strOrNull(row.KIND),
        drainageClass: strOrNull(row.DRAINAGE),
        waterTableClass: strOrNull(row.WATERTBL),
      };
      this.soilNameBySoilId.set(record.soilId, record);
    }
  }

  /**
   * Loads the SLT (soil layer) table, normalizes each row into an
   * `SltRecord`, and indexes them by `SOIL_ID`. A soil has multiple layers
   * (one per depth range), so entries accumulate into a list per soil;
   * `getLayers` sorts that list by depth on read.
   */
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
        saturatedHydraulicConductivity: numOrNull(row.KSAT),
      };
      pushTo(this.soilLayersBySoilId, record.soilId, record);
    }
  }

  /**
   * Loads the LST (landscape segmentation) table, normalizes each row into
   * an `LstRecord`, and indexes them by `POLY_ID`. A polygon can have
   * several landscape segments (each covering a `PERCENT` share of it, each
   * with its own slope classification via `LFS_ID`), so entries accumulate
   * into a list per polygon.
   */
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

  /**
   * Loads the LDT (landform definition) table, normalizes each row into an
   * `LdtRecord`, and indexes them by `LFS_ID`. This is the small reference
   * table (~84 rows) that translates a landscape segment's coded slope
   * classification into an actual slope percentage and human-readable name.
   */
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

  /**
   * Reads every record out of a standalone `.dbf` table (one with no
   * matching `.shp`, e.g. the CMP/CRT/SNT/SLT/LST/LDT tables) into a plain
   * array. The `shapefile` library exposes dbf rows as an async pull stream
   * (`read()` returns `{ done, value }` until exhausted), which this drains
   * fully before returning so callers can iterate with a normal `for...of`.
   *
   * @param filename - The dbf file's name, resolved relative to `dataDir`.
   * @returns Every row in the table as raw (un-normalized) field/value pairs.
   */
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

/**
 * Appends a value to the array stored at `key` in `map`, creating that array
 * on first insert. Used to build the one-to-many indices (e.g. multiple soil
 * components per polygon) without a separate "does this key exist yet" check
 * at every call site.
 */
function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * Picks the item with the highest `percent` from a list — the "dominant"
 * entry used to collapse a polygon's multiple soil components or landscape
 * segments down to the single representative one the soil profile reports.
 *
 * @param items - Candidate items, or `undefined` if the key had no entries.
 * @returns The item with the largest `percent`, or `null` if `items` is
 *   missing/empty.
 */
function maxByPercent<T extends { percent: number }>(
  items: T[] | undefined,
): T | null {
  if (!items || items.length === 0) return null;
  return items.reduce((best, item) =>
    item.percent > best.percent ? item : best,
  );
}

/**
 * Computes the axis-aligned bounding box of a GeoJSON `Polygon` or
 * `MultiPolygon` geometry by recursively walking its nested coordinate
 * arrays (rings, and for MultiPolygon, parts-of-rings) down to individual
 * `[x, y]` pairs and tracking the running min/max. Used to build the cheap
 * pre-filter index in `loadPolygons` — computing this once at load time
 * means `findPolygonId` never has to re-derive it per query.
 *
 * @param geometry - The polygon or multi-polygon geometry to measure.
 * @returns `[minX, minY, maxX, maxY]` (i.e. `[minLng, minLat, maxLng, maxLat]`).
 */
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

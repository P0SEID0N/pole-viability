import { Injectable, Logger } from '@nestjs/common';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { CachedScore } from './interfaces/cached-score.interface';

const DEFAULT_DB_PATH = join(process.cwd(), 'data', 'viability-scores.db');

interface ScoreRow {
  lat: number;
  lng: number;
  long_term_risk: number;
  short_term_risk: number;
  overall_risk: number;
  soil_wetness_risk: number;
  mean_wind_speed_kmh: number | null;
  computed_at: string;
  updated_at: string;
}

/**
 * Persists computed viability scores keyed by exact (lat, lng), so a repeat
 * request for the same location can reuse `longTermRisk` (soil + 30-year
 * climate normals — expensive to fetch, genuinely stable) instead of
 * re-fetching soil/climate every time. `shortTermRisk` is never read back
 * from here as-is — it's always recomputed live and the row updated
 * afterward (see `PoleViabilityService`); this table only ever holds each
 * location's most recent computation, not a history of past ones.
 *
 * SQLite via `better-sqlite3` (synchronous, file-based, zero server) —
 * "very simple database" for a single-row-per-location cache doesn't need
 * more than this. The DB file defaults to `data/viability-scores.db`
 * (gitignored, same pattern as `landscape_data/`), overridable via
 * `SCORE_CACHE_DB_PATH` (tests use `:memory:` to stay isolated/deterministic).
 */
@Injectable()
export class ScoreCacheRepository {
  private readonly logger = new Logger(ScoreCacheRepository.name);
  private readonly db: Database.Database;

  constructor() {
    const dbPath = process.env.SCORE_CACHE_DB_PATH ?? DEFAULT_DB_PATH;
    if (dbPath !== ':memory:') {
      mkdirSync(join(dbPath, '..'), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS viability_scores (
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        long_term_risk REAL NOT NULL,
        short_term_risk REAL NOT NULL,
        overall_risk REAL NOT NULL,
        soil_wetness_risk REAL NOT NULL,
        mean_wind_speed_kmh REAL,
        computed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (lat, lng)
      );
    `);
    this.logger.log(`Score cache ready at ${dbPath}`);
  }

  /** Looks up the cached score for an exact (lat, lng) match, or null if this location has never been computed before. */
  findByLocation(lat: number, lng: number): CachedScore | null {
    const row = this.db
      .prepare<[number, number], ScoreRow>(
        'SELECT * FROM viability_scores WHERE lat = ? AND lng = ?',
      )
      .get(lat, lng);
    return row ? this.toCachedScore(row) : null;
  }

  /**
   * Inserts (or fully overwrites) a location's cached score after a full
   * cache-miss computation — sets `computedAt` to now.
   */
  upsertFullScore(score: Omit<CachedScore, 'computedAt' | 'updatedAt'>): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO viability_scores
           (lat, lng, long_term_risk, short_term_risk, overall_risk, soil_wetness_risk, mean_wind_speed_kmh, computed_at, updated_at)
         VALUES (@lat, @lng, @longTermRisk, @shortTermRisk, @overallRisk, @soilWetnessRisk, @meanWindSpeedKmh, @now, @now)
         ON CONFLICT(lat, lng) DO UPDATE SET
           long_term_risk = @longTermRisk,
           short_term_risk = @shortTermRisk,
           overall_risk = @overallRisk,
           soil_wetness_risk = @soilWetnessRisk,
           mean_wind_speed_kmh = @meanWindSpeedKmh,
           computed_at = @now,
           updated_at = @now`,
      )
      .run({ ...score, now });
  }

  /**
   * Updates just the live-derived fields for an existing row after a cache
   * hit recomputes `shortTermRisk` — `longTermRisk`/`soilWetnessRisk`/
   * `meanWindSpeedKmh` (and `computedAt`) are left untouched.
   */
  updateShortTerm(
    lat: number,
    lng: number,
    shortTermRisk: number,
    overallRisk: number,
  ): void {
    this.db
      .prepare(
        `UPDATE viability_scores
         SET short_term_risk = @shortTermRisk, overall_risk = @overallRisk, updated_at = @now
         WHERE lat = @lat AND lng = @lng`,
      )
      .run({
        lat,
        lng,
        shortTermRisk,
        overallRisk,
        now: new Date().toISOString(),
      });
  }

  private toCachedScore(row: ScoreRow): CachedScore {
    return {
      lat: row.lat,
      lng: row.lng,
      longTermRisk: row.long_term_risk,
      shortTermRisk: row.short_term_risk,
      overallRisk: row.overall_risk,
      soilWetnessRisk: row.soil_wetness_risk,
      meanWindSpeedKmh: row.mean_wind_speed_kmh,
      computedAt: row.computed_at,
      updatedAt: row.updated_at,
    };
  }
}

import { ScoreCacheRepository } from './score-cache.repository';

describe('ScoreCacheRepository', () => {
  let repository: ScoreCacheRepository;

  beforeEach(() => {
    // In-memory DB per test — isolated and deterministic, no file left on disk.
    process.env.SCORE_CACHE_DB_PATH = ':memory:';
    repository = new ScoreCacheRepository();
  });

  it('returns null for a location that has never been computed', () => {
    expect(repository.findByLocation(50.4452, -104.6189)).toBeNull();
  });

  it('stores and retrieves a full score by exact (lat, lng)', () => {
    repository.upsertFullScore({
      lat: 50.4452,
      lng: -104.6189,
      longTermRisk: 0.2421148355113637,
      shortTermRisk: 0.1587,
      overallRisk: 0.2897248355113637,
      soilWetnessRisk: 0.11625,
      meanWindSpeedKmh: 18.42,
    });

    const cached = repository.findByLocation(50.4452, -104.6189);

    expect(cached?.longTermRisk).toBeCloseTo(0.2421148355113637, 10);
    expect(cached?.shortTermRisk).toBeCloseTo(0.1587, 10);
    expect(cached?.soilWetnessRisk).toBeCloseTo(0.11625, 10);
    expect(cached?.meanWindSpeedKmh).toBe(18.42);
    expect(cached?.computedAt).toEqual(cached?.updatedAt);
  });

  it('does not match a different (lat, lng), even a very close one', () => {
    repository.upsertFullScore({
      lat: 50.4452,
      lng: -104.6189,
      longTermRisk: 0.2,
      shortTermRisk: 0.1,
      overallRisk: 0.23,
      soilWetnessRisk: 0.1,
      meanWindSpeedKmh: 18,
    });

    expect(repository.findByLocation(50.4453, -104.6189)).toBeNull();
  });

  it('stores a null meanWindSpeedKmh when the climate normal is unavailable', () => {
    repository.upsertFullScore({
      lat: 50.4452,
      lng: -104.6189,
      longTermRisk: 0.2,
      shortTermRisk: 0.1,
      overallRisk: 0.23,
      soilWetnessRisk: 0.1,
      meanWindSpeedKmh: null,
    });

    expect(
      repository.findByLocation(50.4452, -104.6189)?.meanWindSpeedKmh,
    ).toBeNull();
  });

  it('updateShortTerm changes only shortTermRisk/overallRisk/updatedAt, leaving longTermRisk and computedAt untouched', async () => {
    repository.upsertFullScore({
      lat: 50.4452,
      lng: -104.6189,
      longTermRisk: 0.2421148355113637,
      shortTermRisk: 0.1587,
      overallRisk: 0.2897248355113637,
      soilWetnessRisk: 0.11625,
      meanWindSpeedKmh: 18.42,
    });
    const original = repository.findByLocation(50.4452, -104.6189)!;

    // Ensure a measurable timestamp difference.
    await new Promise((resolve) => setTimeout(resolve, 5));
    repository.updateShortTerm(50.4452, -104.6189, 0.5, 0.4);
    const updated = repository.findByLocation(50.4452, -104.6189)!;

    expect(updated.shortTermRisk).toBe(0.5);
    expect(updated.overallRisk).toBe(0.4);
    expect(updated.longTermRisk).toBeCloseTo(original.longTermRisk, 10);
    expect(updated.soilWetnessRisk).toBeCloseTo(original.soilWetnessRisk, 10);
    expect(updated.computedAt).toBe(original.computedAt);
    expect(updated.updatedAt).not.toBe(original.updatedAt);
  });

  it('upsertFullScore on an existing (lat, lng) fully overwrites the row, including computedAt', () => {
    repository.upsertFullScore({
      lat: 50.4452,
      lng: -104.6189,
      longTermRisk: 0.2,
      shortTermRisk: 0.1,
      overallRisk: 0.23,
      soilWetnessRisk: 0.1,
      meanWindSpeedKmh: 15,
    });
    const first = repository.findByLocation(50.4452, -104.6189)!;

    repository.upsertFullScore({
      lat: 50.4452,
      lng: -104.6189,
      longTermRisk: 0.9,
      shortTermRisk: 0.8,
      overallRisk: 1,
      soilWetnessRisk: 0.7,
      meanWindSpeedKmh: 40,
    });
    const second = repository.findByLocation(50.4452, -104.6189)!;

    expect(second.longTermRisk).toBe(0.9);
    expect(second.meanWindSpeedKmh).toBe(40);
    expect(second.computedAt >= first.computedAt).toBe(true);
  });
});

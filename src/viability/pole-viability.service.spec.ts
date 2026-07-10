import { Test, TestingModule } from '@nestjs/testing';
import { PoleViabilityService } from './pole-viability.service';
import { SoilService } from '../soil/soil.service';
import { ClimateService } from '../climate/climate.service';
import { RiskScoringService } from '../scoring/risk-scoring.service';
import { ScoreCacheRepository } from '../score-cache/score-cache.repository';
import { SoilRiskProfile } from '../soil/interfaces/soil-risk-profile.interface';
import { ClimateRiskProfile } from '../climate/interfaces/climate-risk-profile.interface';
import { CurrentConditionsProfile } from '../climate/interfaces/current-conditions-profile.interface';
import { CachedScore } from '../score-cache/interfaces/cached-score.interface';

const LAT = 50.4452;
const LNG = -104.6189;

/**
 * Mocks every dependency: this test is about `PoleViabilityService`'s own
 * cache hit/miss branching, not the real soil/climate/scoring logic (each
 * already covered by their own unit tests).
 */
describe('PoleViabilityService', () => {
  let service: PoleViabilityService;
  let soilService: { getSoilRiskProfile: jest.Mock };
  let climateService: {
    getClimateRiskProfile: jest.Mock;
    getCurrentConditions: jest.Mock;
  };
  let riskScoringService: {
    calculateViabilityScore: jest.Mock;
    calculateShortTermRiskOnly: jest.Mock;
  };
  let scoreCacheRepository: {
    findByLocation: jest.Mock;
    upsertFullScore: jest.Mock;
    updateShortTerm: jest.Mock;
  };

  const soilProfile = { dataAvailable: true } as SoilRiskProfile;
  const climateProfile = { dataAvailable: true } as ClimateRiskProfile;
  const currentConditions = { dataAvailable: true } as CurrentConditionsProfile;

  beforeEach(async () => {
    soilService = {
      getSoilRiskProfile: jest.fn().mockResolvedValue(soilProfile),
    };
    climateService = {
      getClimateRiskProfile: jest.fn().mockResolvedValue(climateProfile),
      getCurrentConditions: jest.fn().mockResolvedValue(currentConditions),
    };
    riskScoringService = {
      calculateViabilityScore: jest.fn(),
      calculateShortTermRiskOnly: jest.fn(),
    };
    scoreCacheRepository = {
      findByLocation: jest.fn(),
      upsertFullScore: jest.fn(),
      updateShortTerm: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PoleViabilityService,
        { provide: SoilService, useValue: soilService },
        { provide: ClimateService, useValue: climateService },
        { provide: RiskScoringService, useValue: riskScoringService },
        { provide: ScoreCacheRepository, useValue: scoreCacheRepository },
      ],
    }).compile();

    service = moduleRef.get(PoleViabilityService);
  });

  describe('cache miss', () => {
    beforeEach(() => {
      scoreCacheRepository.findByLocation.mockReturnValue(null);
    });

    it('fetches all three inputs and computes a full score', async () => {
      riskScoringService.calculateViabilityScore.mockReturnValue({
        score: {
          dataAvailable: true,
          overallRisk: 0.29,
          shortTermRisk: 0.16,
          longTermRisk: 0.24,
        },
        cacheable: {
          longTermRisk: 0.2421,
          soilWetnessRisk: 0.11625,
          meanWindSpeedKmh: 18.42,
        },
      });

      const score = await service.getViabilityAssessment(LAT, LNG);

      expect(soilService.getSoilRiskProfile).toHaveBeenCalledWith(LAT, LNG);
      expect(climateService.getClimateRiskProfile).toHaveBeenCalledWith(
        LAT,
        LNG,
      );
      expect(climateService.getCurrentConditions).toHaveBeenCalledWith(
        LAT,
        LNG,
      );
      expect(riskScoringService.calculateViabilityScore).toHaveBeenCalledWith(
        soilProfile,
        climateProfile,
        currentConditions,
      );
      expect(score).toEqual({
        dataAvailable: true,
        overallRisk: 0.29,
        shortTermRisk: 0.16,
        longTermRisk: 0.24,
      });
    });

    it('persists the result when cacheable', async () => {
      riskScoringService.calculateViabilityScore.mockReturnValue({
        score: {
          dataAvailable: true,
          overallRisk: 0.29,
          shortTermRisk: 0.16,
          longTermRisk: 0.24,
        },
        cacheable: {
          longTermRisk: 0.2421,
          soilWetnessRisk: 0.11625,
          meanWindSpeedKmh: 18.42,
        },
      });

      await service.getViabilityAssessment(LAT, LNG);

      expect(scoreCacheRepository.upsertFullScore).toHaveBeenCalledWith({
        lat: LAT,
        lng: LNG,
        longTermRisk: 0.2421,
        shortTermRisk: 0.16,
        overallRisk: 0.29,
        soilWetnessRisk: 0.11625,
        meanWindSpeedKmh: 18.42,
      });
      expect(scoreCacheRepository.updateShortTerm).not.toHaveBeenCalled();
    });

    it('does not persist anything when the location has no data (cacheable=null)', async () => {
      riskScoringService.calculateViabilityScore.mockReturnValue({
        score: {
          dataAvailable: false,
          overallRisk: null,
          shortTermRisk: null,
          longTermRisk: null,
        },
        cacheable: null,
      });

      await service.getViabilityAssessment(LAT, LNG);

      expect(scoreCacheRepository.upsertFullScore).not.toHaveBeenCalled();
    });
  });

  describe('cache hit', () => {
    const cached: CachedScore = {
      lat: LAT,
      lng: LNG,
      longTermRisk: 0.2421148355113637,
      shortTermRisk: 0.1587,
      overallRisk: 0.2897248355113637,
      soilWetnessRisk: 0.11625,
      meanWindSpeedKmh: 18.42,
      computedAt: '2026-07-10T16:00:00.000Z',
      updatedAt: '2026-07-10T16:00:00.000Z',
    };

    beforeEach(() => {
      scoreCacheRepository.findByLocation.mockReturnValue(cached);
    });

    it('skips fetching soil and climate normals, but still fetches live current conditions', async () => {
      riskScoringService.calculateShortTermRiskOnly.mockReturnValue({
        dataAvailable: true,
        overallRisk: 0.35,
        shortTermRisk: 0.3,
        longTermRisk: 0.24,
      });

      await service.getViabilityAssessment(LAT, LNG);

      expect(soilService.getSoilRiskProfile).not.toHaveBeenCalled();
      expect(climateService.getClimateRiskProfile).not.toHaveBeenCalled();
      expect(climateService.getCurrentConditions).toHaveBeenCalledWith(
        LAT,
        LNG,
      );
    });

    it('recomputes short-term risk using the cached long-term state', async () => {
      riskScoringService.calculateShortTermRiskOnly.mockReturnValue({
        dataAvailable: true,
        overallRisk: 0.35,
        shortTermRisk: 0.3,
        longTermRisk: 0.24,
      });

      const score = await service.getViabilityAssessment(LAT, LNG);

      expect(
        riskScoringService.calculateShortTermRiskOnly,
      ).toHaveBeenCalledWith(currentConditions, {
        longTermRisk: cached.longTermRisk,
        soilWetnessRisk: cached.soilWetnessRisk,
        meanWindSpeedKmh: cached.meanWindSpeedKmh,
      });
      expect(score.shortTermRisk).toBe(0.3);
    });

    it('updates the stored shortTermRisk/overallRisk after a successful recompute', async () => {
      riskScoringService.calculateShortTermRiskOnly.mockReturnValue({
        dataAvailable: true,
        overallRisk: 0.35,
        shortTermRisk: 0.3,
        longTermRisk: 0.24,
      });

      await service.getViabilityAssessment(LAT, LNG);

      expect(scoreCacheRepository.updateShortTerm).toHaveBeenCalledWith(
        LAT,
        LNG,
        0.3,
        0.35,
      );
      expect(scoreCacheRepository.upsertFullScore).not.toHaveBeenCalled();
    });

    it('does not update the stored row when current conditions are unavailable', async () => {
      riskScoringService.calculateShortTermRiskOnly.mockReturnValue({
        dataAvailable: false,
        overallRisk: null,
        shortTermRisk: null,
        longTermRisk: null,
      });

      await service.getViabilityAssessment(LAT, LNG);

      expect(scoreCacheRepository.updateShortTerm).not.toHaveBeenCalled();
    });
  });
});

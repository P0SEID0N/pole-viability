import { Injectable } from '@nestjs/common';
import { SlcDataRepository } from './slc-data.repository';
import { SoilRiskProfile } from './interfaces/soil-risk-profile.interface';

@Injectable()
export class SoilService {
  constructor(private readonly slcData: SlcDataRepository) {}

  /**
   * Looks up the raw soil risk factors for a location from the SLC dataset.
   * This returns joined data, not a computed score — scoring is a separate step.
   */
  async getSoilRiskProfile(lat: number, lng: number): Promise<SoilRiskProfile> {
    await this.slcData.whenReady();

    const polygonId = this.slcData.findPolygonId(lat, lng);
    if (polygonId === null) {
      return {
        location: { lat, lng },
        polygonId: null,
        dataAvailable: false,
        component: null,
        depthToRestriction: null,
        drainage: null,
        layers: [],
        landform: null,
      };
    }

    const component = this.slcData.getDominantComponent(polygonId);
    const rating = component ? this.slcData.getRating(component.cmpId) : null;
    const soilName = component
      ? this.slcData.getSoilName(component.soilId)
      : null;
    const layers = component ? this.slcData.getLayers(component.soilId) : [];
    const dominantLandform = this.slcData.getDominantLandform(polygonId);

    return {
      location: { lat, lng },
      polygonId,
      dataAvailable: true,
      component: component
        ? {
            percentOfPolygon: component.percent,
            slopeClass: component.slopeClass,
            stoninessClass: component.stoninessClass,
            soilId: component.soilId,
            soilName: soilName?.soilName ?? null,
          }
        : null,
      depthToRestriction: rating
        ? {
            depthClass: rating.depthClass,
            restrictionType: rating.restrictionType,
            availableWaterHoldingCapacityClass:
              rating.availableWaterHoldingCapacityClass,
            coarseFragmentClasses: rating.coarseFragmentClasses,
          }
        : null,
      drainage: soilName
        ? {
            kind: soilName.kind,
            drainageClass: soilName.drainageClass,
            waterTableClass: soilName.waterTableClass,
            rootRestriction: soilName.rootRestriction,
          }
        : null,
      layers: layers.map((layer) => ({
        layerNo: layer.layerNo,
        upperDepthCm: layer.upperDepthCm,
        lowerDepthCm: layer.lowerDepthCm,
        bulkDensity: layer.bulkDensity,
        sandPercent: layer.sandPercent,
        siltPercent: layer.siltPercent,
        clayPercent: layer.clayPercent,
        organicCarbonPercent: layer.organicCarbonPercent,
        saturatedHydraulicConductivity: layer.saturatedHydraulicConductivity,
      })),
      landform: dominantLandform
        ? {
            slopePercent: dominantLandform.landform?.slopePercent ?? null,
            slopeSegmentPercent: dominantLandform.segment.percent,
            name: dominantLandform.landform?.name ?? null,
          }
        : null,
    };
  }
}

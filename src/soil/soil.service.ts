import { Injectable } from '@nestjs/common';
import { SlcDataRepository } from './slc-data.repository';
import { SoilRiskProfile } from './interfaces/soil-risk-profile.interface';

@Injectable()
export class SoilService {
  constructor(private readonly slcData: SlcDataRepository) {}

  /**
   * Looks up the raw soil risk factors for a location from the SLC dataset.
   *
   * Resolves the lat/lng to its containing SLC polygon, then joins across
   * the component (CMP), rating (CRT), soil name (SNT), soil layer (SLT),
   * and landscape segmentation (LST/LDT) tables — see README.md "Soil data
   * (SLC)" for what each table contributes and why. When a polygon has
   * multiple soil components or landscape segments, only the dominant one
   * (highest `PERCENT`) is used; see `SlcDataRepository.getDominantComponent`
   * and `getDominantLandform`.
   *
   * This returns joined, normalized data, not a computed risk score —
   * scoring is a separate, later step that consumes this profile.
   *
   * @param lat - Latitude in decimal degrees.
   * @param lng - Longitude in decimal degrees.
   * @returns The joined soil profile for the location. If the point falls
   *   outside SLC coverage (e.g. open ocean, outside Canada), `dataAvailable`
   *   is `false` and all factor fields are `null`/empty.
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
            stoninessClass: component.stoninessClass,
            soilId: component.soilId,
            soilName: soilName?.soilName ?? null,
          }
        : null,
      depthToRestriction: rating
        ? {
            depthClass: rating.depthClass,
            restrictionType: rating.restrictionType,
          }
        : null,
      drainage: soilName
        ? {
            kind: soilName.kind,
            drainageClass: soilName.drainageClass,
            waterTableClass: soilName.waterTableClass,
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

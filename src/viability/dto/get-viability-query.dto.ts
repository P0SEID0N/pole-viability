import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude } from 'class-validator';

/**
 * Query params for `GET /viability`. Only lat/lng are supported for now —
 * city-name input requires geocoding, which isn't built yet (see README.md
 * "Open questions"). `@Type(() => Number)` coerces the raw query strings
 * before `@IsLatitude`/`@IsLongitude` validate their range, so an
 * out-of-range or non-numeric value is rejected with a 400 before it ever
 * reaches `SoilService`.
 */
export class GetViabilityQueryDto {
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @Type(() => Number)
  @IsLongitude()
  lng: number;
}

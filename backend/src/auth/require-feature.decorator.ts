import { SetMetadata } from '@nestjs/common';

export const REQUIRE_FEATURE_KEY = 'require_feature';

export interface RequireFeatureOptions {
  featureSlug: string;
  minLevel: 'C' | 'T1' | 'T2' | 'T3';
}

export const RequireFeature = (featureSlug: string, minLevel: 'C' | 'T1' | 'T2' | 'T3' = 'C') =>
  SetMetadata(REQUIRE_FEATURE_KEY, { featureSlug, minLevel });

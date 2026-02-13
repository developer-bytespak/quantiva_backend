// src/common/decorators/require-feature.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const REQUIRED_FEATURE_KEY = 'requiredFeature';

export interface FeatureConfig {
  type: string;
  limit?: number;
}

export const RequireFeature = (featureConfig: FeatureConfig) =>
  SetMetadata(REQUIRED_FEATURE_KEY, featureConfig);
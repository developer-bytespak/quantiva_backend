// src/common/decorators/allow-tier.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const ALLOWED_TIERS_KEY = 'allowedTiers';

export const AllowTier = (...tiers: string[]) =>
  SetMetadata(ALLOWED_TIERS_KEY, tiers);
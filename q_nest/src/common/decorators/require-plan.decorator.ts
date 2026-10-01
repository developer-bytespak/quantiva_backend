// src/common/decorators/require-plan.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const REQUIRED_PLAN_KEY = 'requiredPlan';

export const RequirePlan = (plan: 'FREE' | 'PRO' | 'ELITE' | 'ELITE_PLUS' | 'PREMIUM') =>
  SetMetadata(REQUIRED_PLAN_KEY, plan);
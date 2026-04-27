// Local mirrors of Prisma enums. The project's @prisma/client wrapper does not re-export
// these specific enums (see commented import in src/common/feature-access.service.ts), so
// we mirror them here to keep type safety. Values must stay in sync with prisma/schema.prisma.

export const OnboardingState = {
  SIGNED_UP: 'SIGNED_UP',
  PERSONAL_INFO: 'PERSONAL_INFO',
  KYC: 'KYC',
  PAID: 'PAID',
  CONNECT_EXCHANGE: 'CONNECT_EXCHANGE',
  COMPLETED: 'COMPLETED',
} as const;
export type OnboardingState = (typeof OnboardingState)[keyof typeof OnboardingState];

export const ReminderCampaign = {
  FUNNEL: 'FUNNEL',
  FREE_UPGRADE: 'FREE_UPGRADE',
} as const;
export type ReminderCampaign = (typeof ReminderCampaign)[keyof typeof ReminderCampaign];

export const ReminderStatus = {
  QUEUED: 'QUEUED',
  SENT: 'SENT',
  CANCELLED: 'CANCELLED',
} as const;
export type ReminderStatus = (typeof ReminderStatus)[keyof typeof ReminderStatus];

export const PlanTier = {
  FREE: 'FREE',
  PRO: 'PRO',
  ELITE: 'ELITE',
  ELITE_PLUS: 'ELITE_PLUS',
} as const;
export type PlanTier = (typeof PlanTier)[keyof typeof PlanTier];

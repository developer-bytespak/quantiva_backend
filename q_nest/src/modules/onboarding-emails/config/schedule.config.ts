import { OnboardingState, ReminderCampaign } from '../types';

export interface ReminderEntry {
  campaign: ReminderCampaign;
  state: OnboardingState | null;
  delaySeconds: number;
  delayLabel: string;
  templateName: string;
}

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const REMINDER_SCHEDULE: ReminderEntry[] = [
  // Stage 1 — SIGNED_UP (waiting for personal info)
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.SIGNED_UP, delaySeconds: 5 * MIN,  delayLabel: '5min', templateName: 'signed_up_5min' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.SIGNED_UP, delaySeconds: 1 * HOUR, delayLabel: '1h',   templateName: 'signed_up_1h' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.SIGNED_UP, delaySeconds: 1 * DAY,  delayLabel: '24h',  templateName: 'signed_up_24h' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.SIGNED_UP, delaySeconds: 3 * DAY,  delayLabel: '3d',   templateName: 'signed_up_3d' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.SIGNED_UP, delaySeconds: 7 * DAY,  delayLabel: '7d',   templateName: 'signed_up_7d' },

  // Stage 2 — PERSONAL_INFO (waiting for KYC)
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.PERSONAL_INFO, delaySeconds: 1 * HOUR, delayLabel: '1h',  templateName: 'personal_info_1h' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.PERSONAL_INFO, delaySeconds: 6 * HOUR, delayLabel: '6h',  templateName: 'personal_info_6h' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.PERSONAL_INFO, delaySeconds: 1 * DAY,  delayLabel: '24h', templateName: 'personal_info_24h' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.PERSONAL_INFO, delaySeconds: 3 * DAY,  delayLabel: '3d',  templateName: 'personal_info_3d' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.PERSONAL_INFO, delaySeconds: 7 * DAY,  delayLabel: '7d',  templateName: 'personal_info_7d' },

  // Stage 3 — KYC (waiting for plan)
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.KYC, delaySeconds: 15 * MIN, delayLabel: '15min', templateName: 'kyc_15min' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.KYC, delaySeconds: 3 * HOUR, delayLabel: '3h',    templateName: 'kyc_3h' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.KYC, delaySeconds: 1 * DAY,  delayLabel: '24h',   templateName: 'kyc_24h' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.KYC, delaySeconds: 3 * DAY,  delayLabel: '3d',    templateName: 'kyc_3d' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.KYC, delaySeconds: 7 * DAY,  delayLabel: '7d',    templateName: 'kyc_7d' },

  // Stage 4 — PAID (waiting for exchange)
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.PAID, delaySeconds: 30 * MIN, delayLabel: '30min', templateName: 'paid_30min' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.PAID, delaySeconds: 6 * HOUR, delayLabel: '6h',    templateName: 'paid_6h' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.PAID, delaySeconds: 1 * DAY,  delayLabel: '24h',   templateName: 'paid_24h' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.PAID, delaySeconds: 3 * DAY,  delayLabel: '3d',    templateName: 'paid_3d' },
  { campaign: ReminderCampaign.FUNNEL, state: OnboardingState.PAID, delaySeconds: 7 * DAY,  delayLabel: '7d',    templateName: 'paid_7d' },

  // Engine 2 — Free upgrade
  { campaign: ReminderCampaign.FREE_UPGRADE, state: null, delaySeconds: 1 * DAY,  delayLabel: '1d',  templateName: 'free_upgrade_1d' },
  { campaign: ReminderCampaign.FREE_UPGRADE, state: null, delaySeconds: 3 * DAY,  delayLabel: '3d',  templateName: 'free_upgrade_3d' },
  { campaign: ReminderCampaign.FREE_UPGRADE, state: null, delaySeconds: 7 * DAY,  delayLabel: '7d',  templateName: 'free_upgrade_7d' },
  { campaign: ReminderCampaign.FREE_UPGRADE, state: null, delaySeconds: 15 * DAY, delayLabel: '15d', templateName: 'free_upgrade_15d' },
  { campaign: ReminderCampaign.FREE_UPGRADE, state: null, delaySeconds: 30 * DAY, delayLabel: '30d', templateName: 'free_upgrade_30d' },
];

export const QUEUE_NAME = 'onboarding-reminders';

export function entriesForFunnelStage(state: OnboardingState): ReminderEntry[] {
  return REMINDER_SCHEDULE.filter(
    (e) => e.campaign === ReminderCampaign.FUNNEL && e.state === state,
  );
}

export function entriesForFreeUpgrade(): ReminderEntry[] {
  return REMINDER_SCHEDULE.filter((e) => e.campaign === ReminderCampaign.FREE_UPGRADE);
}

export function getDelayMultiplier(): number {
  const raw = process.env.DRIP_DELAY_MULTIPLIER;
  const parsed = raw ? parseFloat(raw) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

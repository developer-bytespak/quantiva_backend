import { SubscriptionsService } from './subscriptions.service';

/**
 * Focused unit tests for the Premium / trial logic. Prisma and collaborators
 * are hand-rolled mocks; no database.
 */

const PREMIUM_PLAN = {
  plan_id: '5b0d1a4e-0000-4000-8000-000000000001',
  tier: 'PREMIUM',
  billing_period: 'MONTHLY',
  price: '29.99',
  is_active: true,
  plan_features: [
    { feature_type: 'CUSTOM_STRATEGIES', enabled: true, limit_value: null },
    { feature_type: 'VC_POOL_ACCESS', enabled: true, limit_value: null },
  ],
};

const FREE_PLAN = {
  plan_id: 'free-plan',
  tier: 'FREE',
  billing_period: 'MONTHLY',
  is_active: true,
  plan_features: [],
};

function buildPrisma() {
  const tx: any = {
    user_subscriptions: { create: jest.fn(), update: jest.fn() },
    users: { update: jest.fn(), updateMany: jest.fn() },
    subscription_usage: { deleteMany: jest.fn(), createMany: jest.fn() },
    strategies: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
  };
  const prisma: any = {
    users: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    payment_history: { findFirst: jest.fn() },
    user_subscriptions: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    subscription_plans: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    __tx: tx,
  };
  return prisma;
}

function buildService(prisma: any) {
  const onboardingState = { advanceTo: jest.fn() };
  const freeUpgrade = { stop: jest.fn(), start: jest.fn() };
  const service = new SubscriptionsService(
    prisma,
    { createNotification: jest.fn(), sendNotification: jest.fn() } as any,
    { sendNewSubscriptionNotification: jest.fn(), sendSubscriptionChangedNotification: jest.fn() } as any,
    { emitNotificationCount: jest.fn() } as any,
    onboardingState as any,
    freeUpgrade as any,
    { recordSubscriptionPayment: jest.fn(), clawbackForSubscriptionIfRecent: jest.fn() } as any,
    undefined,
  );
  return { service, onboardingState, freeUpgrade };
}

describe('SubscriptionsService.isTrialEligible', () => {
  it('is eligible when never trialed and never paid', async () => {
    const prisma = buildPrisma();
    prisma.users.findUnique.mockResolvedValue({ trial_used_at: null });
    prisma.payment_history.findFirst.mockResolvedValue(null);
    prisma.user_subscriptions.findFirst.mockResolvedValue(null);
    const { service } = buildService(prisma);
    await expect(service.isTrialEligible('u1')).resolves.toBe(true);
  });

  it('is not eligible once trial_used_at is set', async () => {
    const prisma = buildPrisma();
    prisma.users.findUnique.mockResolvedValue({ trial_used_at: new Date() });
    const { service } = buildService(prisma);
    await expect(service.isTrialEligible('u1')).resolves.toBe(false);
    expect(prisma.payment_history.findFirst).not.toHaveBeenCalled();
  });

  it('is not eligible with a past succeeded payment', async () => {
    const prisma = buildPrisma();
    prisma.users.findUnique.mockResolvedValue({ trial_used_at: null });
    prisma.payment_history.findFirst.mockResolvedValue({ payment_id: 'p1' });
    const { service } = buildService(prisma);
    await expect(service.isTrialEligible('u1')).resolves.toBe(false);
  });

  it('is not eligible with a past provider-billed paid row (any status)', async () => {
    const prisma = buildPrisma();
    prisma.users.findUnique.mockResolvedValue({ trial_used_at: null });
    prisma.payment_history.findFirst.mockResolvedValue(null);
    prisma.user_subscriptions.findFirst.mockResolvedValue({ subscription_id: 's1' });
    const { service } = buildService(prisma);
    await expect(service.isTrialEligible('u1')).resolves.toBe(false);
  });
});

describe('SubscriptionsService.syncFromStripeSubscription', () => {
  const NOW = new Date('2026-10-01T00:00:00Z');
  const unix = (d: Date) => Math.floor(d.getTime() / 1000);
  const trialEnd = new Date('2026-10-08T00:00:00Z');
  const periodEnd = trialEnd;

  const trialingSub = {
    id: 'sub_123',
    status: 'trialing',
    customer: 'cus_1',
    cancel_at_period_end: false,
    trial_start: unix(NOW),
    trial_end: unix(trialEnd),
    metadata: { user_id: 'u1', plan_id: PREMIUM_PLAN.plan_id },
    items: {
      data: [
        {
          id: 'si_1',
          price: { id: 'price_premium' },
          current_period_start: unix(NOW),
          current_period_end: unix(periodEnd),
        },
      ],
    },
  };

  beforeAll(() => jest.useFakeTimers({ now: NOW }));
  afterAll(() => jest.useRealTimers());

  it('upgrades the signup FREE row to PREMIUM as active+trialing and marks the trial used', async () => {
    const prisma = buildPrisma();
    const freeRow = {
      subscription_id: 'local_free',
      user_id: 'u1',
      plan_id: FREE_PLAN.plan_id,
      tier: 'FREE',
      status: 'active',
      started_at: new Date('2026-09-01'),
      cancelled_at: null,
      current_period_start: new Date('2026-09-01'),
      plan: FREE_PLAN,
    };
    // 1st call: by external_id -> none. 2nd call: user's active row -> FREE row.
    prisma.user_subscriptions.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(freeRow);
    prisma.subscription_plans.findFirst.mockResolvedValue(PREMIUM_PLAN);
    prisma.__tx.user_subscriptions.update.mockImplementation(async ({ data }: any) => ({
      ...freeRow,
      ...data,
    }));

    const { service, onboardingState, freeUpgrade } = buildService(prisma);
    const row = await service.syncFromStripeSubscription(trialingSub, { premiumPriceId: 'price_premium' });

    expect(row).toBeTruthy();
    const update = prisma.__tx.user_subscriptions.update.mock.calls[0][0];
    expect(update.where).toEqual({ subscription_id: 'local_free' });
    expect(update.data).toMatchObject({
      plan_id: PREMIUM_PLAN.plan_id,
      tier: 'PREMIUM',
      status: 'active',
      billing_provider: 'stripe',
      external_id: 'sub_123',
      provider_status: 'trialing',
      auto_renew: true,
      cancelled_at: null,
      expires_at: null,
    });
    expect(update.data.trial_end.getTime()).toBe(trialEnd.getTime());
    expect(update.data.next_billing_date.getTime()).toBe(trialEnd.getTime());

    expect(prisma.__tx.users.update).toHaveBeenCalledWith({
      where: { user_id: 'u1' },
      data: { current_tier: 'PREMIUM' },
    });
    expect(prisma.__tx.users.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 'u1', trial_used_at: null } }),
    );
    expect(prisma.__tx.subscription_usage.deleteMany).toHaveBeenCalled();
    expect(onboardingState.advanceTo).toHaveBeenCalledWith('u1', 'PAID');
    expect(freeUpgrade.stop).toHaveBeenCalledWith('u1');
  });

  it('mirrors cancel_at_period_end without changing tier', async () => {
    const prisma = buildPrisma();
    const premiumRow = {
      subscription_id: 'local_prem',
      user_id: 'u1',
      plan_id: PREMIUM_PLAN.plan_id,
      tier: 'PREMIUM',
      status: 'active',
      started_at: NOW,
      cancelled_at: null,
      current_period_start: NOW,
      plan: PREMIUM_PLAN,
    };
    prisma.user_subscriptions.findFirst.mockResolvedValueOnce(premiumRow);
    prisma.subscription_plans.findFirst.mockResolvedValue(PREMIUM_PLAN);
    prisma.__tx.user_subscriptions.update.mockImplementation(async ({ data }: any) => ({ ...premiumRow, ...data }));

    const { service, onboardingState } = buildService(prisma);
    await service.syncFromStripeSubscription(
      { ...trialingSub, status: 'active', cancel_at_period_end: true, trial_end: null, trial_start: null },
      { premiumPriceId: 'price_premium' },
    );

    const update = prisma.__tx.user_subscriptions.update.mock.calls[0][0];
    expect(update.data).toMatchObject({ auto_renew: false, provider_status: 'active' });
    expect(update.data.tier).toBeUndefined(); // plan unchanged
    expect(update.data.expires_at.getTime()).toBe(periodEnd.getTime());
    expect(update.data.cancelled_at).toBeInstanceOf(Date);
    expect(prisma.__tx.subscription_usage.deleteMany).not.toHaveBeenCalled();
    expect(onboardingState.advanceTo).not.toHaveBeenCalled();
  });

  it('keeps access on past_due', async () => {
    const prisma = buildPrisma();
    const premiumRow = {
      subscription_id: 'local_prem',
      user_id: 'u1',
      plan_id: PREMIUM_PLAN.plan_id,
      tier: 'PREMIUM',
      status: 'active',
      started_at: NOW,
      cancelled_at: null,
      current_period_start: NOW,
      plan: PREMIUM_PLAN,
    };
    prisma.user_subscriptions.findFirst.mockResolvedValueOnce(premiumRow);
    prisma.subscription_plans.findFirst.mockResolvedValue(PREMIUM_PLAN);
    prisma.__tx.user_subscriptions.update.mockImplementation(async ({ data }: any) => ({ ...premiumRow, ...data }));

    const { service } = buildService(prisma);
    await service.syncFromStripeSubscription(
      { ...trialingSub, status: 'past_due', trial_end: null, trial_start: null },
      { premiumPriceId: 'price_premium' },
    );
    const update = prisma.__tx.user_subscriptions.update.mock.calls[0][0];
    expect(update.data).toMatchObject({ status: 'active', provider_status: 'past_due' });
    expect(prisma.__tx.users.update).toHaveBeenCalledWith({
      where: { user_id: 'u1' },
      data: { current_tier: 'PREMIUM' },
    });
  });

  it('downgrades to FREE when Stripe reports canceled', async () => {
    const prisma = buildPrisma();
    prisma.user_subscriptions.findFirst
      .mockResolvedValueOnce({ subscription_id: 'local_prem', user_id: 'u1', status: 'active', plan: PREMIUM_PLAN })
      // handleStripeSubscriptionCancelled lookup
      .mockResolvedValueOnce({ subscription_id: 'local_prem', user_id: 'u1', status: 'active', current_period_end: periodEnd });
    prisma.subscription_plans.findFirst.mockResolvedValue(FREE_PLAN);
    prisma.__tx.user_subscriptions.update.mockResolvedValue({ subscription_id: 'local_prem', user_id: 'u1' });

    const { service, freeUpgrade } = buildService(prisma);
    await service.syncFromStripeSubscription({ ...trialingSub, status: 'canceled' }, { premiumPriceId: 'price_premium' });

    const update = prisma.__tx.user_subscriptions.update.mock.calls[0][0];
    expect(update.data).toMatchObject({ status: 'cancelled', tier: 'FREE', auto_renew: false });
    expect(prisma.__tx.users.update).toHaveBeenCalledWith({
      where: { user_id: 'u1' },
      data: { current_tier: 'FREE' },
    });
    expect(freeUpgrade.start).toHaveBeenCalledWith('u1');
  });

  it('ignores incomplete subscriptions and unknown users', async () => {
    const prisma = buildPrisma();
    prisma.user_subscriptions.findFirst.mockResolvedValue(null);
    prisma.users.findFirst.mockResolvedValue(null);
    const { service } = buildService(prisma);

    await expect(
      service.syncFromStripeSubscription({ ...trialingSub, metadata: {}, customer: 'cus_x' }),
    ).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

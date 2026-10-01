import { StripeController } from './stripe.controller';

/**
 * Webhook and cancel behaviour for the Premium plan. All collaborators are
 * hand-rolled mocks; `constructWebhookEvent` returns the event we hand in.
 */

const USER = 'user-1';
const PRICE = 'price_premium';
const PLAN_ID = '5b0d1a4e-0000-4000-8000-000000000001';

function unix(iso: string) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function buildDeps(overrides: Partial<Record<string, any>> = {}) {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_PREMIUM_PRICE_ID = PRICE;

  const prisma: any = {
    billing_webhook_events: { create: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    users: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ email: 'u@example.com', username: 'u', full_name: null, stripe_customer_id: null }),
    },
    user_subscriptions: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    payment_history: { findFirst: jest.fn().mockResolvedValue(null) },
    qhq_transactions: { findFirst: jest.fn().mockResolvedValue(null) },
    qhq_subscription_discounts: { update: jest.fn().mockResolvedValue({}) },
    subscription_plans: { findUnique: jest.fn().mockResolvedValue({ price: '29.99' }) },
  };

  const stripeService: any = {
    premiumPriceId: PRICE,
    premiumPriceIdFor: jest.fn(() => PRICE),
    premiumPriceMap: jest.fn(() => ({ [PRICE]: 'MONTHLY' })),
    constructWebhookEvent: jest.fn((payload: any) => JSON.parse(payload.toString())),
    retrieveSubscription: jest.fn(),
    cancelSubscriptionAtPeriodEnd: jest.fn(),
    cancelSubscriptionImmediately: jest.fn(),
    resumeSubscription: jest.fn(),
    switchSubscriptionPrice: jest.fn(),
    getPeriodEnd: jest.fn((sub: any) => {
      const u = sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end;
      return typeof u === 'number' ? new Date(u * 1000) : null;
    }),
    getSubscriptionIdFromInvoice: jest.fn((inv: any) => inv?.parent?.subscription_details?.subscription ?? inv?.subscription ?? null),
  };

  const subscriptionsService: any = {
    syncFromStripeSubscription: jest.fn(),
    recordPayment: jest.fn().mockResolvedValue({ payment_id: 'p1' }),
    handleStripeSubscriptionCancelled: jest.fn().mockResolvedValue({ subscription_id: 's1' }),
    handleAdminOverrideSubscriptionCancelled: jest.fn(),
    cancelUserSubscription: jest.fn(),
    resumeStripeSubscriptionLocal: jest.fn(),
    getPremiumPlan: jest.fn().mockResolvedValue({ plan_id: PLAN_ID, tier: 'PREMIUM', billing_period: 'MONTHLY', price: '29.99' }),
    isTrialEligible: jest.fn().mockResolvedValue(true),
    clearSubscriptionCache: jest.fn(),
  };

  const notificationsService: any = {
    createNotification: jest.fn().mockResolvedValue({ id: 'n1' }),
    sendNotification: jest.fn(),
  };
  const appGateway: any = { emitNotificationCount: jest.fn() };
  const tradeFeesService: any = { processCancellationFees: jest.fn().mockResolvedValue(undefined) };
  const qhqService: any = {
    getRuleAmount: jest.fn().mockResolvedValue(25),
    earnTokens: jest.fn().mockResolvedValue({}),
    getPendingDiscount: jest.fn().mockResolvedValue(null),
  };
  const emailSender: any = { send: jest.fn().mockResolvedValue({ ok: true }) };

  const deps = { prisma, stripeService, subscriptionsService, notificationsService, appGateway, tradeFeesService, qhqService, emailSender, ...overrides };
  const controller = new StripeController(
    deps.stripeService,
    deps.appGateway,
    deps.notificationsService,
    deps.subscriptionsService,
    deps.tradeFeesService,
    deps.prisma,
    deps.qhqService,
    deps.emailSender,
  );
  return { controller, ...deps };
}

function webhookReq(event: any) {
  return { rawBody: Buffer.from(JSON.stringify(event)) } as any;
}

describe('StripeController webhook', () => {
  it('skips an event id that was already processed', async () => {
    const d = buildDeps();
    d.prisma.billing_webhook_events.create.mockRejectedValueOnce({ code: 'P2002' });
    const res = await d.controller.handleWebhook(
      webhookReq({ id: 'evt_dup', type: 'invoice.paid', data: { object: {} } }),
      'sig',
    );
    expect(res).toEqual({ received: true, duplicate: true });
    expect(d.stripeService.retrieveSubscription).not.toHaveBeenCalled();
  });

  it('checkout.session.completed with a trial syncs the subscription, records NO payment and awards NO QHQ', async () => {
    const d = buildDeps();
    const trialEnd = unix('2026-10-08T00:00:00Z');
    d.stripeService.retrieveSubscription.mockResolvedValue({ id: 'sub_1', status: 'trialing', trial_end: trialEnd });
    d.subscriptionsService.syncFromStripeSubscription.mockResolvedValue({
      user_id: USER,
      plan_id: PLAN_ID,
      billing_period: 'MONTHLY',
      trial_end: new Date(trialEnd * 1000),
      next_billing_date: new Date(trialEnd * 1000),
    });
    d.prisma.subscription_plans = { findUnique: jest.fn().mockResolvedValue({ price: '29.99' }) };

    await d.controller.handleWebhook(
      webhookReq({
        id: 'evt_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_1',
            mode: 'subscription',
            client_reference_id: USER,
            customer: 'cus_1',
            subscription: 'sub_1',
            amount_total: 0,
            metadata: { user_id: USER, plan_id: PLAN_ID, qhq_discount_id: 'disc_1' },
          },
        },
      }),
      'sig',
    );

    expect(d.prisma.users.update).toHaveBeenCalledWith({ where: { user_id: USER }, data: { stripe_customer_id: 'cus_1' } });
    expect(d.subscriptionsService.syncFromStripeSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sub_1' }),
      expect.objectContaining({ premiumPriceMap: { [PRICE]: 'MONTHLY' }, userIdHint: USER }),
    );
    expect(d.subscriptionsService.recordPayment).not.toHaveBeenCalled();
    expect(d.qhqService.earnTokens).not.toHaveBeenCalled();
    expect(d.prisma.qhq_subscription_discounts.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'disc_1' } }),
    );
    expect(d.notificationsService.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subscription_trial_started' }),
    );
    expect(d.emailSender.send).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Your 7-day Premium trial has started' }));
    expect(d.prisma.billing_webhook_events.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { event_id: 'evt_1' }, data: expect.objectContaining({ error: null }) }),
    );
  });

  it('invoice.paid ignores $0 invoices and trade-fee invoices without a subscription', async () => {
    const d = buildDeps();
    await d.controller.handleWebhook(
      webhookReq({ id: 'evt_2', type: 'invoice.paid', data: { object: { id: 'in_0', amount_paid: 0, parent: { subscription_details: { subscription: 'sub_1' } } } } }),
      'sig',
    );
    await d.controller.handleWebhook(
      webhookReq({ id: 'evt_3', type: 'invoice.paid', data: { object: { id: 'in_fee', amount_paid: 123, billing_reason: 'manual' } } }),
      'sig',
    );
    expect(d.subscriptionsService.recordPayment).not.toHaveBeenCalled();
    expect(d.stripeService.retrieveSubscription).not.toHaveBeenCalled();
  });

  it('invoice.paid for the post-trial charge records the payment and QHQ exactly once', async () => {
    const d = buildDeps();
    d.stripeService.retrieveSubscription.mockResolvedValue({ id: 'sub_1', status: 'active' });
    d.prisma.user_subscriptions.findFirst.mockResolvedValue({
      subscription_id: 's1',
      user_id: USER,
      tier: 'PREMIUM',
      billing_period: 'MONTHLY',
    });

    const invoice = {
      id: 'in_1',
      amount_paid: 2999,
      currency: 'usd',
      billing_reason: 'subscription_cycle',
      hosted_invoice_url: 'https://inv',
      parent: { subscription_details: { subscription: 'sub_1' } },
    };

    await d.controller.handleWebhook(webhookReq({ id: 'evt_4', type: 'invoice.paid', data: { object: invoice } }), 'sig');

    expect(d.subscriptionsService.recordPayment).toHaveBeenCalledTimes(1);
    expect(d.subscriptionsService.recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 29.99, currency: 'USD', status: 'succeeded', external_payment_id: 'in_1' }),
    );
    expect(d.qhqService.earnTokens).toHaveBeenCalledWith(USER, expect.anything(), 25, expect.any(String), 'in_1');

    // Replay with a new event id but the same invoice: payment row and QHQ already exist.
    d.prisma.payment_history.findFirst.mockResolvedValue({ payment_id: 'p1' });
    d.prisma.qhq_transactions.findFirst.mockResolvedValue({ id: 'q1' });
    await d.controller.handleWebhook(webhookReq({ id: 'evt_5', type: 'invoice.paid', data: { object: invoice } }), 'sig');

    expect(d.subscriptionsService.recordPayment).toHaveBeenCalledTimes(1);
    expect(d.qhqService.earnTokens).toHaveBeenCalledTimes(1);
  });

  it('invoice.payment_failed keeps access and records a failed payment', async () => {
    const d = buildDeps();
    d.prisma.user_subscriptions.findFirst.mockResolvedValue({ subscription_id: 's1', user_id: USER, tier: 'PREMIUM', billing_period: 'MONTHLY' });

    await d.controller.handleWebhook(
      webhookReq({
        id: 'evt_6',
        type: 'invoice.payment_failed',
        data: { object: { id: 'in_f', amount_due: 2999, currency: 'usd', hosted_invoice_url: 'https://pay', parent: { subscription_details: { subscription: 'sub_1' } } } },
      }),
      'sig',
    );

    expect(d.prisma.user_subscriptions.update).toHaveBeenCalledWith({ where: { subscription_id: 's1' }, data: { provider_status: 'past_due' } });
    expect(d.subscriptionsService.recordPayment).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', external_payment_id: 'in_f' }));
    expect(d.subscriptionsService.handleStripeSubscriptionCancelled).not.toHaveBeenCalled();
    expect(d.emailSender.send).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining('payment did not go through') }));
  });

  it('customer.subscription.deleted downgrades, bills outstanding trade fees and notifies', async () => {
    const d = buildDeps();
    d.prisma.user_subscriptions.findFirst.mockResolvedValue({ user_id: USER, status: 'active' });
    await d.controller.handleWebhook(
      webhookReq({ id: 'evt_7', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', items: { data: [{ current_period_end: unix('2026-11-01T00:00:00Z') }] } } } }),
      'sig',
    );
    expect(d.subscriptionsService.handleStripeSubscriptionCancelled).toHaveBeenCalledWith('sub_1', new Date('2026-11-01T00:00:00Z'));
    expect(d.tradeFeesService.processCancellationFees).toHaveBeenCalledWith(USER);
    expect(d.notificationsService.createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'subscription_ended' }));
  });

  it('trial_will_end sends exactly one reminder', async () => {
    const d = buildDeps();
    d.prisma.user_subscriptions.findFirst
      .mockResolvedValueOnce({ subscription_id: 's1', user_id: USER, auto_renew: true, cancelled_at: null, trial_reminder_sent_at: null, trial_end: new Date('2026-10-08') })
      .mockResolvedValueOnce({ subscription_id: 's1', user_id: USER, auto_renew: true, cancelled_at: null, trial_reminder_sent_at: new Date(), trial_end: new Date('2026-10-08') });

    const evt = (id: string) => webhookReq({ id, type: 'customer.subscription.trial_will_end', data: { object: { id: 'sub_1', trial_end: unix('2026-10-08T00:00:00Z') } } });
    await d.controller.handleWebhook(evt('evt_8'), 'sig');
    await d.controller.handleWebhook(evt('evt_9'), 'sig');

    expect(d.emailSender.send).toHaveBeenCalledTimes(1);
    expect(d.prisma.user_subscriptions.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trial_reminder_sent_at: expect.any(Date) }) }),
    );
  });
});

describe('StripeController cancel / resume', () => {
  const req = { subscriptionUser: { user_id: USER } } as any;

  it('cancels at period end (never immediately) and bills trade fees', async () => {
    const d = buildDeps();
    d.prisma.user_subscriptions.findFirst.mockResolvedValue({
      subscription_id: 's1',
      tier: 'PREMIUM',
      billing_provider: 'stripe',
      external_id: 'sub_1',
      auto_renew: true,
      cancelled_at: null,
      trial_end: new Date(Date.now() + 3 * 86400000),
      current_period_end: new Date(Date.now() + 3 * 86400000),
    });
    d.stripeService.cancelSubscriptionAtPeriodEnd.mockResolvedValue({ items: { data: [{ current_period_end: unix('2026-10-08T00:00:00Z') }] } });
    d.subscriptionsService.cancelUserSubscription.mockResolvedValue({ subscription_id: 's1', status: 'active', auto_renew: false });

    const res = await d.controller.cancelSubscription(req);

    expect(d.stripeService.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledWith('sub_1');
    expect(d.stripeService.cancelSubscriptionImmediately).not.toHaveBeenCalled();
    expect(d.tradeFeesService.processCancellationFees).toHaveBeenCalledWith(USER);
    expect(res).toMatchObject({ is_trialing: true, auto_renew: false, access_until: new Date('2026-10-08T00:00:00Z') });
    expect(d.emailSender.send).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Your Premium trial is cancelled' }));
  });

  it('refuses to cancel an Apple-billed subscription with a helpful message', async () => {
    const d = buildDeps();
    d.prisma.user_subscriptions.findFirst.mockResolvedValue({ tier: 'PREMIUM', billing_provider: 'apple', external_id: 'orig_1', auto_renew: true });
    await expect(d.controller.cancelSubscription(req)).rejects.toThrow(/App Store/);
  });

  it('resume undoes a scheduled cancellation', async () => {
    const d = buildDeps();
    d.prisma.user_subscriptions.findFirst.mockResolvedValue({
      subscription_id: 's1',
      tier: 'PREMIUM',
      billing_provider: 'stripe',
      external_id: 'sub_1',
      auto_renew: false,
      cancelled_at: new Date(),
      current_period_end: new Date(Date.now() + 86400000),
      status: 'active',
    });
    d.stripeService.resumeSubscription.mockResolvedValue({ items: { data: [{ current_period_end: unix('2026-11-01T00:00:00Z') }] } });
    d.subscriptionsService.resumeStripeSubscriptionLocal.mockResolvedValue({ subscription_id: 's1', status: 'active' });

    const res = await d.controller.resumeSubscription(req);
    expect(d.stripeService.resumeSubscription).toHaveBeenCalledWith('sub_1');
    expect(res).toMatchObject({ auto_renew: true, current_period_end: new Date('2026-11-01T00:00:00Z') });
  });

  it('checkout passes a 7-day trial only to eligible users and ignores client price ids', async () => {
    const d = buildDeps();
    d.prisma.user_subscriptions.findFirst.mockResolvedValue({ tier: 'FREE' });
    d.stripeService.createCheckoutSession = jest.fn().mockResolvedValue({ url: 'https://checkout', id: 'cs_1' });

    const res = await d.controller.createCheckout({
      subscriptionUser: { user_id: USER },
      body: { price_id: 'price_evil', plan_id: 'ELITE_YEARLY', success_url: 'https://s', cancel_url: 'https://c' },
    } as any);

    expect(d.stripeService.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        priceId: PRICE,
        trialDays: 7,
        metadata: expect.objectContaining({ plan_id: PLAN_ID, billing_period: 'MONTHLY' }),
      }),
    );
    expect(res).toMatchObject({ url: 'https://checkout', trial: true, trial_days: 7, billing_period: 'MONTHLY' });

    d.subscriptionsService.isTrialEligible.mockResolvedValue(false);
    await d.controller.createCheckout({ subscriptionUser: { user_id: USER }, body: {} } as any);
    expect(d.stripeService.createCheckoutSession).toHaveBeenLastCalledWith(expect.objectContaining({ trialDays: 0 }));
  });

  it('change-period swaps the Stripe price with no proration and syncs the row', async () => {
    const d = buildDeps();
    d.prisma.user_subscriptions.findFirst.mockResolvedValue({
      subscription_id: 's1',
      tier: 'PREMIUM',
      billing_period: 'MONTHLY',
      billing_provider: 'stripe',
      external_id: 'sub_1',
      auto_renew: true,
      cancelled_at: null,
      current_period_end: new Date('2026-11-01T00:00:00Z'),
    });
    d.stripeService.premiumPriceIdFor = jest.fn((p: string) => `price_${p.toLowerCase()}`);
    d.stripeService.switchSubscriptionPrice = jest.fn().mockResolvedValue({ changed: true, subscription: { id: 'sub_1' } });
    d.subscriptionsService.getPremiumPlan = jest.fn().mockResolvedValue({ plan_id: 'plan_Y', billing_period: 'YEARLY', price: '299.99' });
    d.subscriptionsService.syncFromStripeSubscription.mockResolvedValue({
      subscription_id: 's1',
      next_billing_date: new Date('2026-11-01T00:00:00Z'),
    });

    const res = await d.controller.changeBillingPeriod({ subscriptionUser: { user_id: USER }, body: { billing_period: 'YEARLY' } } as any);

    expect(d.stripeService.switchSubscriptionPrice).toHaveBeenCalledWith('sub_1', 'price_yearly');
    expect(d.subscriptionsService.syncFromStripeSubscription).toHaveBeenCalledWith({ id: 'sub_1' }, expect.objectContaining({ userIdHint: USER }));
    expect(res).toMatchObject({ billing_period: 'YEARLY', price: '299.99', effective_on: new Date('2026-11-01T00:00:00Z') });

    await expect(
      d.controller.changeBillingPeriod({ subscriptionUser: { user_id: USER }, body: { billing_period: 'MONTHLY' } } as any),
    ).rejects.toThrow(/already billed/);
  });

  it('change-period refuses Free, Apple-billed and cancel-scheduled subscriptions', async () => {
    const d = buildDeps();
    d.prisma.user_subscriptions.findFirst.mockResolvedValueOnce({ tier: 'FREE' });
    await expect(d.controller.changeBillingPeriod({ subscriptionUser: { user_id: USER }, body: { billing_period: 'YEARLY' } } as any)).rejects.toThrow(/Free plan/);
    d.prisma.user_subscriptions.findFirst.mockResolvedValueOnce({ tier: 'PREMIUM', billing_provider: 'apple', external_id: 'o1', auto_renew: true });
    await expect(d.controller.changeBillingPeriod({ subscriptionUser: { user_id: USER }, body: { billing_period: 'YEARLY' } } as any)).rejects.toThrow(/App Store/);
    d.prisma.user_subscriptions.findFirst.mockResolvedValueOnce({ tier: 'PREMIUM', billing_provider: 'stripe', external_id: 'sub_1', auto_renew: false, cancelled_at: new Date(), billing_period: 'MONTHLY' });
    await expect(d.controller.changeBillingPeriod({ subscriptionUser: { user_id: USER }, body: { billing_period: 'YEARLY' } } as any)).rejects.toThrow(/Resume/);
    expect(d.stripeService.switchSubscriptionPrice).not.toHaveBeenCalled();
  });

  it('checkout clears a stale (test-mode or deleted) Stripe customer id and retries without it', async () => {
    const d = buildDeps();
    d.prisma.user_subscriptions.findFirst.mockResolvedValue({ tier: 'FREE' });
    d.prisma.users.findUnique.mockResolvedValue({ email: 'u@example.com', stripe_customer_id: 'cus_test_old' });
    d.stripeService.createCheckoutSession = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('No such customer'), { code: 'resource_missing', param: 'customer' }))
      .mockResolvedValueOnce({ url: 'https://checkout', id: 'cs_3' });

    const res = await d.controller.createCheckout({ subscriptionUser: { user_id: USER }, body: {} } as any);

    expect(d.stripeService.createCheckoutSession).toHaveBeenCalledTimes(2);
    expect(d.stripeService.createCheckoutSession.mock.calls[0][0]).toMatchObject({ customerId: 'cus_test_old' });
    expect(d.stripeService.createCheckoutSession.mock.calls[1][0]).toMatchObject({ customerId: null, customerEmail: 'u@example.com' });
    expect(d.prisma.users.update).toHaveBeenCalledWith({ where: { user_id: USER }, data: { stripe_customer_id: null } });
    expect(res).toMatchObject({ url: 'https://checkout' });
  });

  it('checkout resolves the yearly price and plan when billing_period is YEARLY, and rejects bad periods', async () => {
    const d = buildDeps();
    d.prisma.user_subscriptions.findFirst.mockResolvedValue({ tier: 'FREE' });
    d.stripeService.premiumPriceIdFor = jest.fn((p: string) => `price_${p.toLowerCase()}`);
    d.subscriptionsService.getPremiumPlan = jest.fn(async (p: string) => ({ plan_id: `plan_${p}`, tier: 'PREMIUM', billing_period: p }));
    d.stripeService.createCheckoutSession = jest.fn().mockResolvedValue({ url: 'https://checkout', id: 'cs_2' });

    const res = await d.controller.createCheckout({
      subscriptionUser: { user_id: USER },
      body: { billing_period: 'YEARLY', success_url: 'https://s', cancel_url: 'https://c' },
    } as any);

    expect(d.subscriptionsService.getPremiumPlan).toHaveBeenCalledWith('YEARLY');
    expect(d.stripeService.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: 'price_yearly', metadata: expect.objectContaining({ plan_id: 'plan_YEARLY', billing_period: 'YEARLY' }) }),
    );
    expect(res).toMatchObject({ billing_period: 'YEARLY' });

    await expect(
      d.controller.createCheckout({ subscriptionUser: { user_id: USER }, body: { billing_period: 'WEEKLY' } } as any),
    ).rejects.toThrow(/billing_period/);
  });
});

-- Premium single-plan switch: trial columns, webhook idempotency ledger,
-- PREMIUM plan row + features, deactivate legacy plans, QHQ rule, trial backfill.

-- AlterTable: user_subscriptions
ALTER TABLE "user_subscriptions"
  ADD COLUMN "trial_start" TIMESTAMP(6),
  ADD COLUMN "trial_end" TIMESTAMP(6),
  ADD COLUMN "trial_reminder_sent_at" TIMESTAMP(6),
  ADD COLUMN "provider_status" VARCHAR(32),
  ADD COLUMN "migrated_to_premium_at" TIMESTAMP(6);

-- AlterTable: users
ALTER TABLE "users" ADD COLUMN "trial_used_at" TIMESTAMP(6);

-- CreateTable: billing_webhook_events
CREATE TABLE "billing_webhook_events" (
  "event_id"     VARCHAR(255) NOT NULL,
  "provider"     VARCHAR(20)  NOT NULL,
  "type"         VARCHAR(100) NOT NULL,
  "received_at"  TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(6),
  "error"        TEXT,
  CONSTRAINT "billing_webhook_events_pkey" PRIMARY KEY ("event_id")
);
CREATE INDEX "billing_webhook_events_provider_type_idx" ON "billing_webhook_events"("provider", "type");

-- PREMIUM plan row (fixed UUID; referenced by src/common/tiers.ts PREMIUM_PLAN_ID)
INSERT INTO "subscription_plans"
  (plan_id, name, description, base_price, billing_period, price, discount_percent, display_order, is_active, tier, created_at)
VALUES
  ('5b0d1a4e-0000-4000-8000-000000000001', 'Premium',
   'Every Quantiva feature. 7-day free trial for first-time subscribers.',
   29.99, 'MONTHLY', 29.99, 0, 1, true, 'PREMIUM', CURRENT_TIMESTAMP)
ON CONFLICT (tier, billing_period) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      base_price = EXCLUDED.base_price,
      price = EXCLUDED.price,
      is_active = true,
      display_order = EXCLUDED.display_order,
      updated_at = CURRENT_TIMESTAMP;

-- All features enabled and unlimited (NULL limit_value = unlimited, matching existing ELITE rows)
INSERT INTO "plan_features" (feature_id, plan_id, feature_type, enabled, limit_value, created_at)
SELECT gen_random_uuid(), '5b0d1a4e-0000-4000-8000-000000000001', f, true, NULL, CURRENT_TIMESTAMP
FROM unnest(ARRAY['CUSTOM_STRATEGIES','VC_POOL_ACCESS','EARLY_ACCESS','OPTIONS_TRADING','TOP_TRADE_FEES']::"FeatureType"[]) AS f
ON CONFLICT (plan_id, feature_type) DO UPDATE
  SET enabled = true, limit_value = NULL, updated_at = CURRENT_TIMESTAMP;

-- Deactivate legacy paid plans (rows and history are kept; FREE must stay active for signup)
UPDATE "subscription_plans"
   SET is_active = false, updated_at = CURRENT_TIMESTAMP
 WHERE tier NOT IN ('FREE', 'PREMIUM');

-- QHQ reward rule for Premium payments (same amount as the old ELITE rule)
INSERT INTO "qhq_reward_rules" (id, rule_key, amount, is_active, description, created_at, updated_at)
SELECT gen_random_uuid(), 'MONTHLY_PREMIUM',
       COALESCE((SELECT amount FROM "qhq_reward_rules" WHERE rule_key = 'MONTHLY_ELITE'), 25),
       true, 'QHQ earned on each Premium subscription payment', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
ON CONFLICT (rule_key) DO NOTHING;

-- Anyone who ever had a paid Stripe/Apple subscription is not eligible for the free trial
UPDATE "users" u
   SET trial_used_at = s.first_paid
  FROM (
    SELECT user_id, MIN(COALESCE(started_at, created_at)) AS first_paid
      FROM "user_subscriptions"
     WHERE tier <> 'FREE' AND billing_provider IN ('stripe', 'apple')
     GROUP BY user_id
  ) s
 WHERE s.user_id = u.user_id AND u.trial_used_at IS NULL;

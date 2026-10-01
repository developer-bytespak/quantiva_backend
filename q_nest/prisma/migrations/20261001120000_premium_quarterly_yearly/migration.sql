-- Premium is sold in three billing periods. Monthly ($29.99) was inserted by
-- 20261001100100; this adds Quarterly ($79.99, ~11% off) and Yearly ($299.99,
-- ~17% off) with the same unlimited feature set. Fixed UUIDs are referenced by
-- src/common/tiers.ts PREMIUM_PLAN_IDS.

INSERT INTO "subscription_plans"
  (plan_id, name, description, base_price, billing_period, price, discount_percent, display_order, is_active, tier, created_at)
VALUES
  ('5b0d1a4e-0000-4000-8000-000000000002', 'Premium',
   'Every Quantiva feature. 7-day free trial for first-time subscribers.',
   29.99, 'QUARTERLY', 79.99, 11.1, 1, true, 'PREMIUM', CURRENT_TIMESTAMP),
  ('5b0d1a4e-0000-4000-8000-000000000003', 'Premium',
   'Every Quantiva feature. 7-day free trial for first-time subscribers.',
   29.99, 'YEARLY', 299.99, 16.6, 1, true, 'PREMIUM', CURRENT_TIMESTAMP)
ON CONFLICT (tier, billing_period) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      base_price = EXCLUDED.base_price,
      price = EXCLUDED.price,
      discount_percent = EXCLUDED.discount_percent,
      is_active = true,
      display_order = EXCLUDED.display_order,
      updated_at = CURRENT_TIMESTAMP;

INSERT INTO "plan_features" (feature_id, plan_id, feature_type, enabled, limit_value, created_at)
SELECT gen_random_uuid(), p.plan_id, f, true, NULL, CURRENT_TIMESTAMP
FROM "subscription_plans" p
CROSS JOIN unnest(ARRAY['CUSTOM_STRATEGIES','VC_POOL_ACCESS','EARLY_ACCESS','OPTIONS_TRADING','TOP_TRADE_FEES']::"FeatureType"[]) AS f
WHERE p.tier = 'PREMIUM'
ON CONFLICT (plan_id, feature_type) DO UPDATE
  SET enabled = true, limit_value = NULL, updated_at = CURRENT_TIMESTAMP;

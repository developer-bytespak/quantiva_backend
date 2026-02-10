/*
  Warnings:

  - You are about to drop the column `features_json` on the `subscription_plans` table. All the data in the column will be lost.
  - You are about to drop the column `price_monthly` on the `subscription_plans` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[tier,billing_period]` on the table `subscription_plans` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `billing_period` to the `subscription_plans` table without a default value. This is not possible if the table is not empty.
  - Added the required column `price` to the `subscription_plans` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tier` to the `subscription_plans` table without a default value. This is not possible if the table is not empty.
  - Added the required column `billing_period` to the `user_subscriptions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tier` to the `user_subscriptions` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('FREE', 'PRO', 'ELITE');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "FeatureType" AS ENUM ('CUSTOM_STRATEGIES', 'VC_POOL_ACCESS', 'EARLY_ACCESS');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'succeeded', 'failed', 'refunded', 'cancelled');

-- DropIndex
DROP INDEX "subscription_plans_name_key";

-- AlterTable
ALTER TABLE "subscription_plans" DROP COLUMN "features_json",
DROP COLUMN "price_monthly",
ADD COLUMN     "base_price" DECIMAL(10,2),
ADD COLUMN     "billing_period" "BillingPeriod" NOT NULL,
ADD COLUMN     "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "discount_percent" DECIMAL(5,2) DEFAULT 0,
ADD COLUMN     "display_order" INTEGER,
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "price" DECIMAL(10,2) NOT NULL,
ADD COLUMN     "tier" "PlanTier" NOT NULL,
ADD COLUMN     "updated_at" TIMESTAMP(6),
ALTER COLUMN "name" SET DATA TYPE VARCHAR(100);

-- AlterTable
ALTER TABLE "user_subscriptions" ADD COLUMN     "auto_renew" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "billing_period" "BillingPeriod" NOT NULL,
ADD COLUMN     "cancelled_at" TIMESTAMP(6),
ADD COLUMN     "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "current_period_end" TIMESTAMP(6),
ADD COLUMN     "current_period_start" TIMESTAMP(6),
ADD COLUMN     "external_id" VARCHAR(255),
ADD COLUMN     "last_payment_date" TIMESTAMP(6),
ADD COLUMN     "next_billing_date" TIMESTAMP(6),
ADD COLUMN     "tier" "PlanTier" NOT NULL,
ADD COLUMN     "updated_at" TIMESTAMP(6);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "current_tier" "PlanTier" NOT NULL DEFAULT 'FREE';

-- CreateTable
CREATE TABLE "plan_features" (
    "feature_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "feature_type" "FeatureType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "limit_value" INTEGER,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "plan_features_pkey" PRIMARY KEY ("feature_id")
);

-- CreateTable
CREATE TABLE "subscription_usage" (
    "usage_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "feature_type" "FeatureType" NOT NULL,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "period_start" TIMESTAMP(6) NOT NULL,
    "period_end" TIMESTAMP(6) NOT NULL,
    "details" JSON,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "subscription_usage_pkey" PRIMARY KEY ("usage_id")
);

-- CreateTable
CREATE TABLE "payment_history" (
    "payment_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "payment_provider" VARCHAR(50),
    "external_payment_id" VARCHAR(255),
    "payment_method" VARCHAR(50),
    "invoice_url" TEXT,
    "receipt_url" TEXT,
    "failure_reason" TEXT,
    "paid_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "payment_history_pkey" PRIMARY KEY ("payment_id")
);

-- CreateIndex
CREATE INDEX "plan_features_plan_id_idx" ON "plan_features"("plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_features_plan_id_feature_type_key" ON "plan_features"("plan_id", "feature_type");

-- CreateIndex
CREATE INDEX "subscription_usage_subscription_id_idx" ON "subscription_usage"("subscription_id");

-- CreateIndex
CREATE INDEX "subscription_usage_user_id_idx" ON "subscription_usage"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_usage_subscription_id_feature_type_key" ON "subscription_usage"("subscription_id", "feature_type");

-- CreateIndex
CREATE INDEX "payment_history_user_id_idx" ON "payment_history"("user_id");

-- CreateIndex
CREATE INDEX "payment_history_subscription_id_idx" ON "payment_history"("subscription_id");

-- CreateIndex
CREATE INDEX "payment_history_status_idx" ON "payment_history"("status");

-- CreateIndex
CREATE INDEX "subscription_plans_tier_idx" ON "subscription_plans"("tier");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_tier_billing_period_key" ON "subscription_plans"("tier", "billing_period");

-- CreateIndex
CREATE INDEX "user_subscriptions_status_idx" ON "user_subscriptions"("status");

-- CreateIndex
CREATE INDEX "user_subscriptions_current_period_end_idx" ON "user_subscriptions"("current_period_end");

-- CreateIndex
CREATE INDEX "users_current_tier_idx" ON "users"("current_tier");

-- AddForeignKey
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("plan_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_usage" ADD CONSTRAINT "subscription_usage_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "user_subscriptions"("subscription_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_usage" ADD CONSTRAINT "subscription_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_history" ADD CONSTRAINT "payment_history_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "user_subscriptions"("subscription_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_history" ADD CONSTRAINT "payment_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

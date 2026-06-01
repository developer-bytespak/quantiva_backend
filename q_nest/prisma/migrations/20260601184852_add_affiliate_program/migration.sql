-- CreateEnum
CREATE TYPE "AffiliateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'PAUSED');

-- CreateEnum
CREATE TYPE "AffiliateApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'INFO_REQUESTED');

-- CreateEnum
CREATE TYPE "AffiliateCommissionTier" AS ENUM ('DEFAULT', 'PREMIUM', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AffiliateCommissionType" AS ENUM ('SUBSCRIPTION_PAYMENT');

-- CreateEnum
CREATE TYPE "AffiliateCommissionStatus" AS ENUM ('ACCRUED', 'PAID', 'CLAWED_BACK', 'HELD');

-- CreateEnum
CREATE TYPE "AffiliatePayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AffiliateChannel" AS ENUM ('YOUTUBE', 'X', 'INSTAGRAM', 'TIKTOK', 'NEWSLETTER', 'BLOG', 'DISCORD_TELEGRAM', 'PODCAST', 'OTHER');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "referred_by_affiliate_id" UUID;

-- CreateTable
CREATE TABLE "affiliates" (
    "affiliate_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "full_name" VARCHAR(120),
    "country" VARCHAR(100),
    "tax_residency" VARCHAR(100),
    "referral_code" VARCHAR(60),
    "status" "AffiliateStatus" NOT NULL DEFAULT 'PENDING',
    "commission_tier" "AffiliateCommissionTier" NOT NULL DEFAULT 'DEFAULT',
    "payout_instructions" TEXT,
    "tax_form_url" TEXT,
    "pending_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paid_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "clawed_back_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "signup_count" INTEGER NOT NULL DEFAULT 0,
    "conversion_count" INTEGER NOT NULL DEFAULT 0,
    "revenue_generated" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "last_activity_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "affiliates_pkey" PRIMARY KEY ("affiliate_id")
);

-- CreateTable
CREATE TABLE "affiliate_sessions" (
    "session_id" UUID NOT NULL,
    "affiliate_id" UUID NOT NULL,
    "issued_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "device_id" VARCHAR(255),
    "ip_address" VARCHAR(45),
    "refresh_token_hash" TEXT,

    CONSTRAINT "affiliate_sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "affiliate_applications" (
    "application_id" UUID NOT NULL,
    "affiliate_id" UUID NOT NULL,
    "primary_channel" "AffiliateChannel" NOT NULL,
    "channel_url" VARCHAR(500),
    "audience_size" INTEGER,
    "pitch" VARCHAR(250) NOT NULL,
    "status" "AffiliateApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "rejection_reason" TEXT,
    "reviewed_by_admin_id" UUID,
    "reviewed_at" TIMESTAMP(6),
    "ip_address" VARCHAR(45),
    "device_id" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "affiliate_applications_pkey" PRIMARY KEY ("application_id")
);

-- CreateTable
CREATE TABLE "affiliate_referrals" (
    "referral_id" UUID NOT NULL,
    "affiliate_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "referral_code" VARCHAR(60) NOT NULL,
    "source" VARCHAR(30) NOT NULL,
    "utm" JSONB,
    "attributed_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_referrals_pkey" PRIMARY KEY ("referral_id")
);

-- CreateTable
CREATE TABLE "affiliate_commission_events" (
    "event_id" UUID NOT NULL,
    "affiliate_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "event_type" "AffiliateCommissionType" NOT NULL,
    "source_reference" VARCHAR(255) NOT NULL,
    "gross_amount_usd" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "commission_rate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "commission_usd" DECIMAL(12,2) NOT NULL,
    "status" "AffiliateCommissionStatus" NOT NULL DEFAULT 'ACCRUED',
    "payout_id" UUID,
    "clawed_back_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_commission_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "affiliate_payouts" (
    "payout_id" UUID NOT NULL,
    "affiliate_id" UUID NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "gross_usd" DECIMAL(12,2) NOT NULL,
    "net_usd" DECIMAL(12,2) NOT NULL,
    "status" "AffiliatePayoutStatus" NOT NULL DEFAULT 'PENDING',
    "payment_reference" TEXT,
    "processed_by_admin_id" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(6),

    CONSTRAINT "affiliate_payouts_pkey" PRIMARY KEY ("payout_id")
);

-- CreateTable
CREATE TABLE "affiliate_audit_log" (
    "log_id" UUID NOT NULL,
    "affiliate_id" UUID,
    "application_id" UUID,
    "actor_admin_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_audit_log_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "affiliate_program_settings" (
    "version" SERIAL NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "subscription_commission_pct" DECIMAL(6,4) NOT NULL DEFAULT 0.20,
    "recurring_months_cap" INTEGER NOT NULL DEFAULT 12,
    "attribution_window_days" INTEGER NOT NULL DEFAULT 30,
    "refund_clawback_days" INTEGER NOT NULL DEFAULT 14,
    "payout_threshold_usd" DECIMAL(10,2) NOT NULL DEFAULT 50.00,
    "payout_cycle" VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
    "premium_tier_multiplier" DECIMAL(6,4) NOT NULL DEFAULT 1.50,
    "affiliate_signup_velocity_24h" INTEGER NOT NULL DEFAULT 50,
    "updated_by_admin_id" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_program_settings_pkey" PRIMARY KEY ("version")
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliates_email_key" ON "affiliates"("email");

-- CreateIndex
CREATE UNIQUE INDEX "affiliates_display_name_key" ON "affiliates"("display_name");

-- CreateIndex
CREATE UNIQUE INDEX "affiliates_referral_code_key" ON "affiliates"("referral_code");

-- CreateIndex
CREATE INDEX "affiliates_status_idx" ON "affiliates"("status");

-- CreateIndex
CREATE INDEX "affiliates_referral_code_idx" ON "affiliates"("referral_code");

-- CreateIndex
CREATE INDEX "affiliate_sessions_affiliate_id_idx" ON "affiliate_sessions"("affiliate_id");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_applications_affiliate_id_key" ON "affiliate_applications"("affiliate_id");

-- CreateIndex
CREATE INDEX "affiliate_applications_status_idx" ON "affiliate_applications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_referrals_user_id_key" ON "affiliate_referrals"("user_id");

-- CreateIndex
CREATE INDEX "affiliate_referrals_affiliate_id_idx" ON "affiliate_referrals"("affiliate_id");

-- CreateIndex
CREATE INDEX "affiliate_commission_events_affiliate_id_status_idx" ON "affiliate_commission_events"("affiliate_id", "status");

-- CreateIndex
CREATE INDEX "affiliate_commission_events_user_id_idx" ON "affiliate_commission_events"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_commission_events_event_type_source_reference_key" ON "affiliate_commission_events"("event_type", "source_reference");

-- CreateIndex
CREATE INDEX "affiliate_payouts_affiliate_id_status_idx" ON "affiliate_payouts"("affiliate_id", "status");

-- CreateIndex
CREATE INDEX "affiliate_payouts_period_idx" ON "affiliate_payouts"("period");

-- CreateIndex
CREATE INDEX "affiliate_audit_log_affiliate_id_idx" ON "affiliate_audit_log"("affiliate_id");

-- AddForeignKey
ALTER TABLE "affiliate_sessions" ADD CONSTRAINT "affiliate_sessions_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("affiliate_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_applications" ADD CONSTRAINT "affiliate_applications_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("affiliate_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_referrals" ADD CONSTRAINT "affiliate_referrals_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("affiliate_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_referrals" ADD CONSTRAINT "affiliate_referrals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_commission_events" ADD CONSTRAINT "affiliate_commission_events_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("affiliate_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_commission_events" ADD CONSTRAINT "affiliate_commission_events_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "affiliate_payouts"("payout_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_payouts" ADD CONSTRAINT "affiliate_payouts_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("affiliate_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_audit_log" ADD CONSTRAINT "affiliate_audit_log_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("affiliate_id") ON DELETE CASCADE ON UPDATE CASCADE;

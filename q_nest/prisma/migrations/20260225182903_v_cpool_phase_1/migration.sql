-- CreateEnum
CREATE TYPE "PoolStatus" AS ENUM ('draft', 'open', 'full', 'active', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "VcPaymentMethod" AS ENUM ('stripe', 'binance');

-- CreateEnum
CREATE TYPE "SeatReservationStatus" AS ENUM ('reserved', 'confirmed', 'released', 'expired');

-- CreateEnum
CREATE TYPE "PaymentSubmissionStatus" AS ENUM ('pending', 'processing', 'verified', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "ExitRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'processed');

-- CreateEnum
CREATE TYPE "PoolPayoutStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "PayoutType" AS ENUM ('completion', 'pool_cancelled');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "stripe_connect_account_id" VARCHAR(255);

-- CreateTable
CREATE TABLE "admins" (
    "admin_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "full_name" VARCHAR(120),
    "stripe_secret_key_encrypted" TEXT,
    "stripe_publishable_key" VARCHAR(255),
    "stripe_webhook_secret_encrypted" TEXT,
    "binance_uid" VARCHAR(100),
    "binance_api_key_encrypted" TEXT,
    "binance_api_secret_encrypted" TEXT,
    "default_pool_fee_percent" DECIMAL(5,2) NOT NULL DEFAULT 5.00,
    "default_admin_profit_fee_percent" DECIMAL(5,2) NOT NULL DEFAULT 20.00,
    "default_cancellation_fee_percent" DECIMAL(5,2) NOT NULL DEFAULT 5.00,
    "default_payment_window_minutes" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "admins_pkey" PRIMARY KEY ("admin_id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "session_id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "issued_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "device_id" VARCHAR(255),
    "ip_address" VARCHAR(45),
    "refresh_token_hash" TEXT,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "vc_pools" (
    "pool_id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "coin_type" VARCHAR(10) NOT NULL DEFAULT 'USDT',
    "contribution_amount" DECIMAL(20,8) NOT NULL,
    "max_members" INTEGER NOT NULL,
    "pool_fee_percent" DECIMAL(5,2) NOT NULL,
    "admin_profit_fee_percent" DECIMAL(5,2) NOT NULL,
    "cancellation_fee_percent" DECIMAL(5,2) NOT NULL,
    "payment_window_minutes" INTEGER NOT NULL DEFAULT 30,
    "duration_days" INTEGER NOT NULL,
    "status" "PoolStatus" NOT NULL DEFAULT 'draft',
    "started_at" TIMESTAMP(6),
    "end_date" TIMESTAMP(6),
    "is_replica" BOOLEAN NOT NULL DEFAULT false,
    "original_pool_id" UUID,
    "verified_members_count" INTEGER NOT NULL DEFAULT 0,
    "reserved_seats_count" INTEGER NOT NULL DEFAULT 0,
    "total_invested_usdt" DECIMAL(20,8),
    "current_pool_value_usdt" DECIMAL(20,8),
    "total_profit_usdt" DECIMAL(20,8),
    "total_pool_fees_usdt" DECIMAL(20,8),
    "admin_fee_earned_usdt" DECIMAL(20,8),
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    "completed_at" TIMESTAMP(6),
    "cancelled_at" TIMESTAMP(6),

    CONSTRAINT "vc_pools_pkey" PRIMARY KEY ("pool_id")
);

-- CreateTable
CREATE TABLE "vc_pool_seat_reservations" (
    "reservation_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "payment_method" "VcPaymentMethod" NOT NULL,
    "reserved_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "status" "SeatReservationStatus" NOT NULL DEFAULT 'reserved',

    CONSTRAINT "vc_pool_seat_reservations_pkey" PRIMARY KEY ("reservation_id")
);

-- CreateTable
CREATE TABLE "vc_pool_payment_submissions" (
    "submission_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "payment_method" "VcPaymentMethod" NOT NULL,
    "investment_amount" DECIMAL(20,8) NOT NULL,
    "pool_fee_amount" DECIMAL(20,8) NOT NULL,
    "total_amount" DECIMAL(20,8) NOT NULL,
    "stripe_checkout_session_id" VARCHAR(255),
    "stripe_payment_intent_id" VARCHAR(255),
    "screenshot_url" TEXT,
    "admin_notes" VARCHAR(500),
    "status" "PaymentSubmissionStatus" NOT NULL DEFAULT 'pending',
    "payment_deadline" TIMESTAMP(6) NOT NULL,
    "rejection_reason" VARCHAR(500),
    "reviewed_by_admin_id" UUID,
    "verified_at" TIMESTAMP(6),
    "submitted_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vc_pool_payment_submissions_pkey" PRIMARY KEY ("submission_id")
);

-- CreateTable
CREATE TABLE "vc_pool_members" (
    "member_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "payment_method" "VcPaymentMethod" NOT NULL,
    "invested_amount_usdt" DECIMAL(20,8) NOT NULL,
    "share_percent" DECIMAL(8,5) NOT NULL,
    "user_binance_uid" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "joined_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exited_at" TIMESTAMP(6),

    CONSTRAINT "vc_pool_members_pkey" PRIMARY KEY ("member_id")
);

-- CreateTable
CREATE TABLE "vc_pool_trades" (
    "trade_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "strategy_id" UUID,
    "admin_id" UUID NOT NULL,
    "asset_pair" VARCHAR(20) NOT NULL,
    "action" "SignalAction" NOT NULL,
    "quantity" DECIMAL(30,10) NOT NULL,
    "entry_price_usdt" DECIMAL(20,8) NOT NULL,
    "exit_price_usdt" DECIMAL(20,8),
    "pnl_usdt" DECIMAL(20,8),
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "binance_order_id" VARCHAR(100),
    "notes" TEXT,
    "traded_at" TIMESTAMP(6) NOT NULL,
    "closed_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vc_pool_trades_pkey" PRIMARY KEY ("trade_id")
);

-- CreateTable
CREATE TABLE "vc_pool_cancellations" (
    "cancellation_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "pool_status_at_request" "PoolStatus" NOT NULL,
    "invested_amount" DECIMAL(20,8) NOT NULL,
    "share_percent_at_exit" DECIMAL(8,5),
    "pool_value_at_exit" DECIMAL(20,8),
    "member_value_at_exit" DECIMAL(20,8) NOT NULL,
    "cancellation_fee_pct" DECIMAL(5,2) NOT NULL,
    "fee_amount" DECIMAL(20,8) NOT NULL,
    "refund_amount" DECIMAL(20,8) NOT NULL,
    "stripe_refund_id" VARCHAR(255),
    "stripe_transfer_id" VARCHAR(255),
    "binance_refund_tx_id" VARCHAR(255),
    "status" "ExitRequestStatus" NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_admin_id" UUID,
    "reviewed_at" TIMESTAMP(6),
    "rejection_reason" VARCHAR(500),
    "refunded_at" TIMESTAMP(6),

    CONSTRAINT "vc_pool_cancellations_pkey" PRIMARY KEY ("cancellation_id")
);

-- CreateTable
CREATE TABLE "vc_pool_payouts" (
    "payout_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "payout_type" "PayoutType" NOT NULL,
    "initial_investment" DECIMAL(20,8) NOT NULL,
    "share_percent" DECIMAL(8,5) NOT NULL,
    "pool_final_value" DECIMAL(20,8),
    "gross_payout" DECIMAL(20,8) NOT NULL,
    "admin_fee_deducted" DECIMAL(20,8) NOT NULL,
    "net_payout" DECIMAL(20,8) NOT NULL,
    "profit_loss" DECIMAL(20,8) NOT NULL,
    "stripe_refund_id" VARCHAR(255),
    "stripe_transfer_id" VARCHAR(255),
    "binance_tx_id" VARCHAR(255),
    "status" "PoolPayoutStatus" NOT NULL DEFAULT 'pending',
    "paid_at" TIMESTAMP(6),
    "notes" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vc_pool_payouts_pkey" PRIMARY KEY ("payout_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");

-- CreateIndex
CREATE INDEX "admin_sessions_admin_id_idx" ON "admin_sessions"("admin_id");

-- CreateIndex
CREATE INDEX "vc_pools_admin_id_idx" ON "vc_pools"("admin_id");

-- CreateIndex
CREATE INDEX "vc_pools_status_idx" ON "vc_pools"("status");

-- CreateIndex
CREATE INDEX "vc_pools_is_archived_idx" ON "vc_pools"("is_archived");

-- CreateIndex
CREATE INDEX "vc_pool_seat_reservations_pool_id_idx" ON "vc_pool_seat_reservations"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_seat_reservations_user_id_idx" ON "vc_pool_seat_reservations"("user_id");

-- CreateIndex
CREATE INDEX "vc_pool_seat_reservations_status_idx" ON "vc_pool_seat_reservations"("status");

-- CreateIndex
CREATE INDEX "vc_pool_seat_reservations_expires_at_idx" ON "vc_pool_seat_reservations"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_seat_reservations_pool_id_user_id_key" ON "vc_pool_seat_reservations"("pool_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_payment_submissions_reservation_id_key" ON "vc_pool_payment_submissions"("reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_payment_submissions_stripe_payment_intent_id_key" ON "vc_pool_payment_submissions"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "vc_pool_payment_submissions_pool_id_idx" ON "vc_pool_payment_submissions"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_payment_submissions_user_id_idx" ON "vc_pool_payment_submissions"("user_id");

-- CreateIndex
CREATE INDEX "vc_pool_payment_submissions_status_idx" ON "vc_pool_payment_submissions"("status");

-- CreateIndex
CREATE INDEX "vc_pool_payment_submissions_stripe_payment_intent_id_idx" ON "vc_pool_payment_submissions"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "vc_pool_members_pool_id_idx" ON "vc_pool_members"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_members_user_id_idx" ON "vc_pool_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_members_pool_id_user_id_key" ON "vc_pool_members"("pool_id", "user_id");

-- CreateIndex
CREATE INDEX "vc_pool_trades_pool_id_idx" ON "vc_pool_trades"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_trades_strategy_id_idx" ON "vc_pool_trades"("strategy_id");

-- CreateIndex
CREATE INDEX "vc_pool_trades_is_open_idx" ON "vc_pool_trades"("is_open");

-- CreateIndex
CREATE INDEX "vc_pool_trades_pool_id_strategy_id_idx" ON "vc_pool_trades"("pool_id", "strategy_id");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_cancellations_member_id_key" ON "vc_pool_cancellations"("member_id");

-- CreateIndex
CREATE INDEX "vc_pool_cancellations_pool_id_idx" ON "vc_pool_cancellations"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_cancellations_member_id_idx" ON "vc_pool_cancellations"("member_id");

-- CreateIndex
CREATE INDEX "vc_pool_cancellations_status_idx" ON "vc_pool_cancellations"("status");

-- CreateIndex
CREATE INDEX "vc_pool_payouts_pool_id_idx" ON "vc_pool_payouts"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_payouts_member_id_idx" ON "vc_pool_payouts"("member_id");

-- CreateIndex
CREATE INDEX "vc_pool_payouts_status_idx" ON "vc_pool_payouts"("status");

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("admin_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pools" ADD CONSTRAINT "vc_pools_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pools" ADD CONSTRAINT "vc_pools_original_pool_id_fkey" FOREIGN KEY ("original_pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_seat_reservations" ADD CONSTRAINT "vc_pool_seat_reservations_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_seat_reservations" ADD CONSTRAINT "vc_pool_seat_reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_payment_submissions" ADD CONSTRAINT "vc_pool_payment_submissions_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_payment_submissions" ADD CONSTRAINT "vc_pool_payment_submissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_payment_submissions" ADD CONSTRAINT "vc_pool_payment_submissions_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "vc_pool_seat_reservations"("reservation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_payment_submissions" ADD CONSTRAINT "vc_pool_payment_submissions_reviewed_by_admin_id_fkey" FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "admins"("admin_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_members" ADD CONSTRAINT "vc_pool_members_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_members" ADD CONSTRAINT "vc_pool_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_trades" ADD CONSTRAINT "vc_pool_trades_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_trades" ADD CONSTRAINT "vc_pool_trades_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("strategy_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_trades" ADD CONSTRAINT "vc_pool_trades_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_cancellations" ADD CONSTRAINT "vc_pool_cancellations_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_cancellations" ADD CONSTRAINT "vc_pool_cancellations_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "vc_pool_members"("member_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_cancellations" ADD CONSTRAINT "vc_pool_cancellations_reviewed_by_admin_id_fkey" FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "admins"("admin_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_payouts" ADD CONSTRAINT "vc_pool_payouts_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_payouts" ADD CONSTRAINT "vc_pool_payouts_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "vc_pool_members"("member_id") ON DELETE RESTRICT ON UPDATE CASCADE;

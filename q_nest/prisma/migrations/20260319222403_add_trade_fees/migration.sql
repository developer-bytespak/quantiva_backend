-- CreateEnum
CREATE TYPE "TradeFeeStatus" AS ENUM ('pending', 'invoiced', 'paid', 'failed', 'waived');

-- CreateEnum
CREATE TYPE "MonthlyFeeStatus" AS ENUM ('accumulating', 'invoiced', 'paid', 'failed', 'below_minimum');

-- CreateEnum
CREATE TYPE "TradeFeeSource" AS ENUM ('top_trade_crypto', 'top_trade_stock');

-- AlterEnum
ALTER TYPE "FeatureType" ADD VALUE 'TOP_TRADE_FEES';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "stripe_customer_id" VARCHAR(255);

-- CreateTable
CREATE TABLE "trade_fees" (
    "fee_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "trade_reference_id" VARCHAR(255),
    "asset_symbol" VARCHAR(50) NOT NULL,
    "trade_side" VARCHAR(10) NOT NULL,
    "trade_value_usd" DECIMAL(18,4) NOT NULL,
    "fee_percent" DECIMAL(8,6) NOT NULL DEFAULT 0.001,
    "fee_amount_usd" DECIMAL(18,6) NOT NULL,
    "status" "TradeFeeStatus" NOT NULL DEFAULT 'pending',
    "source" "TradeFeeSource" NOT NULL DEFAULT 'top_trade_crypto',
    "billing_month" VARCHAR(7) NOT NULL,
    "stripe_invoice_item_id" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_fees_pkey" PRIMARY KEY ("fee_id")
);

-- CreateTable
CREATE TABLE "monthly_fee_summaries" (
    "summary_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "billing_month" VARCHAR(7) NOT NULL,
    "total_trades" INTEGER NOT NULL DEFAULT 0,
    "total_trade_volume_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_fees_usd" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "status" "MonthlyFeeStatus" NOT NULL DEFAULT 'accumulating',
    "stripe_invoice_id" VARCHAR(255),
    "paid_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "monthly_fee_summaries_pkey" PRIMARY KEY ("summary_id")
);

-- CreateIndex
CREATE INDEX "trade_fees_user_id_billing_month_idx" ON "trade_fees"("user_id", "billing_month");

-- CreateIndex
CREATE INDEX "trade_fees_status_idx" ON "trade_fees"("status");

-- CreateIndex
CREATE INDEX "monthly_fee_summaries_status_idx" ON "monthly_fee_summaries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_fee_summaries_user_id_billing_month_key" ON "monthly_fee_summaries"("user_id", "billing_month");

-- AddForeignKey
ALTER TABLE "trade_fees" ADD CONSTRAINT "trade_fees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_fee_summaries" ADD CONSTRAINT "monthly_fee_summaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

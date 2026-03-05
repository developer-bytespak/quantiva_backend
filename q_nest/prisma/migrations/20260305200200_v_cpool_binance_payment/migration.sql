/*
  Warnings:

  - A unique constraint covering the columns `[binance_tx_id]` on the table `vc_pool_payment_submissions` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "BinancePaymentStatus" AS ENUM ('pending', 'verified', 'rejected', 'refunded');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "binance_deposit_address" VARCHAR(255);

-- AlterTable
ALTER TABLE "vc_pool_payment_submissions" ADD COLUMN     "binance_amount_received_usdt" DECIMAL(20,8),
ADD COLUMN     "binance_payment_status" "BinancePaymentStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN     "binance_tx_id" VARCHAR(255),
ADD COLUMN     "binance_tx_timestamp" TIMESTAMP(6),
ADD COLUMN     "exact_amount_expected" DECIMAL(20,8),
ADD COLUMN     "exact_amount_received" DECIMAL(20,8),
ADD COLUMN     "refund_initiated_at" TIMESTAMP(6),
ADD COLUMN     "refund_reason" VARCHAR(500);

-- CreateTable
CREATE TABLE "vc_pool_transactions" (
    "transaction_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "payment_submission_id" UUID,
    "member_id" UUID,
    "transaction_type" VARCHAR(50) NOT NULL,
    "amount_usdt" DECIMAL(20,8) NOT NULL,
    "description" TEXT,
    "binance_tx_id" VARCHAR(255),
    "binance_tx_timestamp" TIMESTAMP(6),
    "expected_amount" DECIMAL(20,8),
    "actual_amount_received" DECIMAL(20,8),
    "status" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(6),

    CONSTRAINT "vc_pool_transactions_pkey" PRIMARY KEY ("transaction_id")
);

-- CreateTable
CREATE TABLE "user_credits" (
    "credit_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credit_amount_usdt" DECIMAL(20,8) NOT NULL,
    "source" VARCHAR(50) NOT NULL,
    "is_spent" BOOLEAN NOT NULL DEFAULT false,
    "spent_on_pool_id" UUID,
    "spent_amount" DECIMAL(20,8),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "spent_at" TIMESTAMP(6),

    CONSTRAINT "user_credits_pkey" PRIMARY KEY ("credit_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_transactions_payment_submission_id_key" ON "vc_pool_transactions"("payment_submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_transactions_binance_tx_id_key" ON "vc_pool_transactions"("binance_tx_id");

-- CreateIndex
CREATE INDEX "vc_pool_transactions_pool_id_idx" ON "vc_pool_transactions"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_transactions_user_id_idx" ON "vc_pool_transactions"("user_id");

-- CreateIndex
CREATE INDEX "vc_pool_transactions_status_idx" ON "vc_pool_transactions"("status");

-- CreateIndex
CREATE INDEX "vc_pool_transactions_created_at_idx" ON "vc_pool_transactions"("created_at");

-- CreateIndex
CREATE INDEX "vc_pool_transactions_binance_tx_id_idx" ON "vc_pool_transactions"("binance_tx_id");

-- CreateIndex
CREATE INDEX "user_credits_user_id_idx" ON "user_credits"("user_id");

-- CreateIndex
CREATE INDEX "user_credits_is_spent_idx" ON "user_credits"("is_spent");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_payment_submissions_binance_tx_id_key" ON "vc_pool_payment_submissions"("binance_tx_id");

-- CreateIndex
CREATE INDEX "vc_pool_payment_submissions_binance_payment_status_idx" ON "vc_pool_payment_submissions"("binance_payment_status");

-- AddForeignKey
ALTER TABLE "vc_pool_transactions" ADD CONSTRAINT "vc_pool_transactions_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_transactions" ADD CONSTRAINT "vc_pool_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_transactions" ADD CONSTRAINT "vc_pool_transactions_payment_submission_id_fkey" FOREIGN KEY ("payment_submission_id") REFERENCES "vc_pool_payment_submissions"("submission_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_transactions" ADD CONSTRAINT "vc_pool_transactions_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "vc_pool_members"("member_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_credits" ADD CONSTRAINT "user_credits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

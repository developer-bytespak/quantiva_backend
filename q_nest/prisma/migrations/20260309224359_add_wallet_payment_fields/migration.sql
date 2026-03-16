/*
  Warnings:

  - A unique constraint covering the columns `[tx_hash]` on the table `vc_pool_payment_submissions` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "admins" ADD COLUMN     "payment_network" VARCHAR(50) DEFAULT 'BSC',
ADD COLUMN     "wallet_address" VARCHAR(255);

-- AlterTable
ALTER TABLE "vc_pool_members" ADD COLUMN     "user_wallet_address" VARCHAR(255);

-- AlterTable
ALTER TABLE "vc_pool_payment_submissions" ADD COLUMN     "tx_hash" VARCHAR(255),
ADD COLUMN     "user_wallet_address" VARCHAR(255);

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_payment_submissions_tx_hash_key" ON "vc_pool_payment_submissions"("tx_hash");

/*
  Warnings:

  - You are about to drop the column `premium_tier_multiplier` on the `affiliate_program_settings` table. All the data in the column will be lost.
  - You are about to drop the column `commission_tier` on the `affiliates` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "affiliate_program_settings" DROP COLUMN "premium_tier_multiplier";

-- AlterTable
ALTER TABLE "affiliates" DROP COLUMN "commission_tier",
ADD COLUMN     "commission_pct" DECIMAL(6,4);

-- DropEnum
DROP TYPE "AffiliateCommissionTier";

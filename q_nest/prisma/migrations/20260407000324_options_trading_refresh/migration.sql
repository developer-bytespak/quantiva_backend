-- AlterEnum
ALTER TYPE "OptionOrderStatus" ADD VALUE 'submitting';

-- AlterTable
ALTER TABLE "options_iv_history" ADD COLUMN     "iv_percentile" DECIMAL(6,4);

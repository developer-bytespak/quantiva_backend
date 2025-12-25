-- AlterTable
ALTER TABLE "trending_assets" ADD COLUMN     "ai_insight" TEXT,
ADD COLUMN     "ai_insight_strategy_id" UUID,
ADD COLUMN     "insight_generated_at" TIMESTAMP(6);

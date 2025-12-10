-- CreateEnum
CREATE TYPE "NewsSource" AS ENUM ('StockNewsAPI', 'LunarCrush');

-- CreateEnum
CREATE TYPE "SentimentLabel" AS ENUM ('positive', 'negative', 'neutral');

-- AlterEnum
ALTER TYPE "SignalAction" ADD VALUE 'HOLD';

-- AlterTable
ALTER TABLE "asset_metrics" ADD COLUMN     "metadata" JSON,
ADD COLUMN     "source" VARCHAR(50);

-- AlterTable
ALTER TABLE "strategy_signals" ADD COLUMN     "engine_metadata" JSON;

-- AlterTable
ALTER TABLE "trending_news" ADD COLUMN     "article_url" TEXT,
ADD COLUMN     "metadata" JSON,
ADD COLUMN     "published_at" TIMESTAMP(6),
ADD COLUMN     "sentiment_label" "SentimentLabel",
ADD COLUMN     "source" "NewsSource";

-- CreateTable
CREATE TABLE "sentiment_ema_state" (
    "asset_id" VARCHAR(100) NOT NULL,
    "ema_value" DOUBLE PRECISION NOT NULL,
    "last_timestamp" TIMESTAMP(6) NOT NULL,
    "momentum" DOUBLE PRECISION,
    "raw_score" DOUBLE PRECISION,
    "metadata" JSON,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sentiment_ema_state_pkey" PRIMARY KEY ("asset_id")
);

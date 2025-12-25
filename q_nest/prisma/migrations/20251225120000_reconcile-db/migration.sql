-- AlterTable: Add columns to assets table
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "display_name" VARCHAR(255),
ADD COLUMN IF NOT EXISTS "logo_url" TEXT,
ADD COLUMN IF NOT EXISTS "coingecko_id" VARCHAR(100),
ADD COLUMN IF NOT EXISTS "market_cap_rank" INTEGER;

-- AlterTable: Add columns to trending_assets table
ALTER TABLE "trending_assets" ADD COLUMN IF NOT EXISTS "price_change_24h" DECIMAL(10,4),
ADD COLUMN IF NOT EXISTS "price_change_24h_usd" DECIMAL(20,8),
ADD COLUMN IF NOT EXISTS "market_cap" DECIMAL(30,2),
ADD COLUMN IF NOT EXISTS "volume_24h" DECIMAL(30,10),
ADD COLUMN IF NOT EXISTS "high_24h" DECIMAL(20,8),
ADD COLUMN IF NOT EXISTS "low_24h" DECIMAL(20,8);

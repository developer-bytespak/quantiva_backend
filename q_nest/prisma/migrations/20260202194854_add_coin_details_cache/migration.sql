-- CreateTable
CREATE TABLE "coin_details" (
    "coin_detail_id" UUID NOT NULL,
    "coingecko_id" VARCHAR(100) NOT NULL,
    "symbol" VARCHAR(50) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "homepage_url" VARCHAR(500),
    "image_url" VARCHAR(500),
    "market_cap_rank" INTEGER,
    "market_cap_usd" DECIMAL(30,2),
    "fully_diluted_valuation_usd" DECIMAL(30,2),
    "circulating_supply" DECIMAL(30,8),
    "total_supply" DECIMAL(30,8),
    "max_supply" DECIMAL(30,8),
    "ath_usd" DECIMAL(20,8),
    "ath_date" TIMESTAMP(6),
    "atl_usd" DECIMAL(20,8),
    "atl_date" TIMESTAMP(6),
    "total_volume_24h" DECIMAL(30,2),
    "current_price_usd" DECIMAL(20,8),
    "price_change_24h" DECIMAL(20,8),
    "price_change_percentage_24h" DECIMAL(10,4),
    "last_updated" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_details_pkey" PRIMARY KEY ("coin_detail_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coin_details_coingecko_id_key" ON "coin_details"("coingecko_id");

-- CreateIndex
CREATE INDEX "coin_details_symbol_idx" ON "coin_details"("symbol");

-- CreateIndex
CREATE INDEX "coin_details_last_updated_idx" ON "coin_details"("last_updated");

-- CreateIndex
CREATE INDEX "coin_details_market_cap_rank_idx" ON "coin_details"("market_cap_rank");

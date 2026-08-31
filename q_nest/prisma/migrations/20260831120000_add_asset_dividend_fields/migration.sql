-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "dividend_yield" DECIMAL(10,6),
ADD COLUMN     "dividend_frequency" VARCHAR(20),
ADD COLUMN     "last_dividend_amount" DECIMAL(18,6),
ADD COLUMN     "ex_dividend_date" DATE,
ADD COLUMN     "dividend_synced_at" TIMESTAMP(6);

-- CreateIndex
CREATE INDEX "assets_asset_type_dividend_synced_at_idx" ON "assets"("asset_type", "dividend_synced_at");

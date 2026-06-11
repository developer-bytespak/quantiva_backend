-- CreateTable
CREATE TABLE "user_holdings" (
    "holding_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "symbol" VARCHAR(50) NOT NULL,
    "asset_type" VARCHAR(20) NOT NULL,
    "asset_id" UUID,
    "quantity" DECIMAL(30,10),
    "exchange" VARCHAR(20) NOT NULL,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_holdings_pkey" PRIMARY KEY ("holding_id")
);

-- CreateIndex
CREATE INDEX "user_holdings_asset_id_idx" ON "user_holdings"("asset_id");

-- CreateIndex
CREATE INDEX "user_holdings_symbol_idx" ON "user_holdings"("symbol");

-- CreateIndex
CREATE INDEX "user_holdings_user_id_idx" ON "user_holdings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_holdings_user_id_symbol_exchange_key" ON "user_holdings"("user_id", "symbol", "exchange");

-- AddForeignKey
ALTER TABLE "user_holdings" ADD CONSTRAINT "user_holdings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_holdings" ADD CONSTRAINT "user_holdings_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE SET NULL ON UPDATE CASCADE;

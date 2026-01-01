/*
  Warnings:

  - A unique constraint covering the columns `[symbol,asset_type]` on the table `assets` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "assets_symbol_asset_type_key" ON "assets"("symbol", "asset_type");

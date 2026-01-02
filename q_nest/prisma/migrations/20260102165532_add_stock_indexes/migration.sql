-- CreateIndex
CREATE INDEX "assets_asset_type_is_active_idx" ON "assets"("asset_type", "is_active");

-- CreateIndex
CREATE INDEX "trending_assets_asset_id_poll_timestamp_idx" ON "trending_assets"("asset_id", "poll_timestamp");

-- CreateIndex
CREATE INDEX "strategy_signals_strategy_id_timestamp_idx" ON "strategy_signals"("strategy_id", "timestamp");

-- CreateIndex
CREATE INDEX "strategy_signals_strategy_id_asset_id_timestamp_idx" ON "strategy_signals"("strategy_id", "asset_id", "timestamp");

-- CreateIndex
CREATE INDEX "strategy_signals_user_id_timestamp_idx" ON "strategy_signals"("user_id", "timestamp");

-- CreateIndex
CREATE INDEX "strategy_signals_asset_id_timestamp_idx" ON "strategy_signals"("asset_id", "timestamp");

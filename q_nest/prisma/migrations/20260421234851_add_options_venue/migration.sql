-- CreateEnum
CREATE TYPE "OptionsVenue" AS ENUM ('BINANCE', 'ALPACA');

-- AlterTable
ALTER TABLE "options_iv_history" ADD COLUMN     "venue" "OptionsVenue" NOT NULL DEFAULT 'BINANCE';

-- AlterTable
ALTER TABLE "options_orders" ADD COLUMN     "broker_order_id" VARCHAR(100),
ADD COLUMN     "group_id" UUID,
ADD COLUMN     "position_intent" VARCHAR(20),
ADD COLUMN     "venue" "OptionsVenue" NOT NULL DEFAULT 'BINANCE';

-- AlterTable
ALTER TABLE "options_positions" ADD COLUMN     "venue" "OptionsVenue" NOT NULL DEFAULT 'BINANCE';

-- AlterTable
ALTER TABLE "options_signals_ai" ADD COLUMN     "venue" "OptionsVenue" NOT NULL DEFAULT 'BINANCE';

-- CreateIndex
CREATE INDEX "options_iv_history_venue_underlying_recorded_at_idx" ON "options_iv_history"("venue", "underlying", "recorded_at");

-- CreateIndex
CREATE INDEX "options_orders_user_id_venue_idx" ON "options_orders"("user_id", "venue");

-- CreateIndex
CREATE INDEX "options_orders_group_id_idx" ON "options_orders"("group_id");

-- CreateIndex
CREATE INDEX "options_positions_user_id_venue_idx" ON "options_positions"("user_id", "venue");

-- CreateIndex
CREATE INDEX "options_signals_ai_venue_underlying_created_at_idx" ON "options_signals_ai"("venue", "underlying", "created_at");

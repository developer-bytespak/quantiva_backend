-- CreateEnum
CREATE TYPE "QueuedTradeStatus" AS ENUM ('queued', 'submitted', 'filled', 'canceled', 'expired', 'failed');

-- CreateTable
CREATE TABLE "pending_queued_trades" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "symbol" VARCHAR(50) NOT NULL,
    "side" VARCHAR(10) NOT NULL,
    "order_type" VARCHAR(10) NOT NULL DEFAULT 'MARKET',
    "quantity" DECIMAL(20,8) NOT NULL,
    "limit_price" DECIMAL(20,8),
    "take_profit_pct" DECIMAL(10,6),
    "stop_loss_pct" DECIMAL(10,6),
    "source" VARCHAR(30) NOT NULL DEFAULT 'top_trade',
    "status" "QueuedTradeStatus" NOT NULL DEFAULT 'queued',
    "alpaca_buy_order_id" VARCHAR(100),
    "tp_order_id" VARCHAR(100),
    "sl_order_id" VARCHAR(100),
    "failure_reason" TEXT,
    "queued_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMP(6),
    "filled_at" TIMESTAMP(6),
    "canceled_at" TIMESTAMP(6),
    "expires_at" TIMESTAMP(6),

    CONSTRAINT "pending_queued_trades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_queued_trades_user_id_idx" ON "pending_queued_trades"("user_id");

-- CreateIndex
CREATE INDEX "pending_queued_trades_connection_id_idx" ON "pending_queued_trades"("connection_id");

-- CreateIndex
CREATE INDEX "pending_queued_trades_status_idx" ON "pending_queued_trades"("status");

-- CreateIndex
CREATE INDEX "pending_queued_trades_user_id_status_idx" ON "pending_queued_trades"("user_id", "status");

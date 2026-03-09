-- CreateEnum
CREATE TYPE "OptionType" AS ENUM ('CALL', 'PUT');

-- CreateEnum
CREATE TYPE "OptionOrderStatus" AS ENUM ('pending', 'filled', 'partially_filled', 'cancelled', 'rejected', 'expired');

-- AlterEnum
ALTER TYPE "FeatureType" ADD VALUE 'OPTIONS_TRADING';

-- AlterEnum
ALTER TYPE "PortfolioType" ADD VALUE 'options';

-- CreateTable
CREATE TABLE "options_orders" (
    "order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "signal_id" UUID,
    "contract_symbol" VARCHAR(50) NOT NULL,
    "underlying" VARCHAR(20) NOT NULL,
    "strike" DECIMAL(20,8) NOT NULL,
    "expiry" TIMESTAMP(6) NOT NULL,
    "option_type" "OptionType" NOT NULL,
    "side" VARCHAR(10) NOT NULL,
    "quantity" DECIMAL(30,10) NOT NULL,
    "price" DECIMAL(20,8),
    "filled_quantity" DECIMAL(30,10),
    "avg_fill_price" DECIMAL(20,8),
    "fee" DECIMAL(20,8),
    "binance_order_id" VARCHAR(100),
    "status" "OptionOrderStatus" NOT NULL DEFAULT 'pending',
    "order_type" VARCHAR(20) NOT NULL DEFAULT 'LIMIT',
    "max_loss" DECIMAL(20,8),
    "greeks_at_entry" JSON,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "options_orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "options_positions" (
    "position_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "order_id" UUID,
    "contract_symbol" VARCHAR(50) NOT NULL,
    "underlying" VARCHAR(20) NOT NULL,
    "strike" DECIMAL(20,8) NOT NULL,
    "expiry" TIMESTAMP(6) NOT NULL,
    "option_type" "OptionType" NOT NULL,
    "quantity" DECIMAL(30,10) NOT NULL,
    "avg_premium" DECIMAL(20,8) NOT NULL,
    "current_premium" DECIMAL(20,8),
    "unrealized_pnl" DECIMAL(20,8),
    "realized_pnl" DECIMAL(20,8),
    "delta" DECIMAL(10,6),
    "gamma" DECIMAL(10,6),
    "theta" DECIMAL(10,6),
    "vega" DECIMAL(10,6),
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "opened_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(6),
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "options_positions_pkey" PRIMARY KEY ("position_id")
);

-- CreateTable
CREATE TABLE "options_signals" (
    "options_signal_id" UUID NOT NULL,
    "signal_id" UUID NOT NULL,
    "recommended_type" "OptionType" NOT NULL,
    "recommended_strike" DECIMAL(20,8) NOT NULL,
    "recommended_expiry" TIMESTAMP(6) NOT NULL,
    "iv_rank" DECIMAL(6,4),
    "iv_value" DECIMAL(10,6),
    "estimated_premium" DECIMAL(20,8),
    "max_loss" DECIMAL(20,8),
    "recommended_qty" DECIMAL(30,10),
    "greeks_snapshot" JSON,
    "liquidity_ok" BOOLEAN NOT NULL DEFAULT true,
    "reasoning" TEXT,
    "confidence_adjustment" DECIMAL(5,4),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "options_signals_pkey" PRIMARY KEY ("options_signal_id")
);

-- CreateIndex
CREATE INDEX "options_orders_user_id_idx" ON "options_orders"("user_id");

-- CreateIndex
CREATE INDEX "options_orders_signal_id_idx" ON "options_orders"("signal_id");

-- CreateIndex
CREATE INDEX "options_orders_status_idx" ON "options_orders"("status");

-- CreateIndex
CREATE INDEX "options_orders_underlying_idx" ON "options_orders"("underlying");

-- CreateIndex
CREATE INDEX "options_orders_user_id_status_idx" ON "options_orders"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "options_positions_order_id_key" ON "options_positions"("order_id");

-- CreateIndex
CREATE INDEX "options_positions_user_id_idx" ON "options_positions"("user_id");

-- CreateIndex
CREATE INDEX "options_positions_is_open_idx" ON "options_positions"("is_open");

-- CreateIndex
CREATE INDEX "options_positions_user_id_is_open_idx" ON "options_positions"("user_id", "is_open");

-- CreateIndex
CREATE INDEX "options_positions_underlying_idx" ON "options_positions"("underlying");

-- CreateIndex
CREATE INDEX "options_positions_expiry_idx" ON "options_positions"("expiry");

-- CreateIndex
CREATE INDEX "options_signals_signal_id_idx" ON "options_signals"("signal_id");

-- AddForeignKey
ALTER TABLE "options_orders" ADD CONSTRAINT "options_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "options_orders" ADD CONSTRAINT "options_orders_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "strategy_signals"("signal_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "options_positions" ADD CONSTRAINT "options_positions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "options_positions" ADD CONSTRAINT "options_positions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "options_orders"("order_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "options_signals" ADD CONSTRAINT "options_signals_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "strategy_signals"("signal_id") ON DELETE RESTRICT ON UPDATE CASCADE;

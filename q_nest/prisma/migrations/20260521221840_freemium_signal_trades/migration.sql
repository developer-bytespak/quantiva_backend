-- CreateTable
CREATE TABLE "free_tier_signal_trades" (
    "user_id" UUID NOT NULL,
    "trades_granted" INTEGER NOT NULL DEFAULT 5,
    "trades_used" INTEGER NOT NULL DEFAULT 0,
    "granted_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(6),

    CONSTRAINT "free_tier_signal_trades_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "free_tier_signal_trade_usages" (
    "usage_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "order_id" VARCHAR(255),
    "symbol" VARCHAR(50) NOT NULL,
    "used_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "free_tier_signal_trade_usages_pkey" PRIMARY KEY ("usage_id")
);

-- CreateIndex
CREATE INDEX "free_tier_signal_trade_usages_user_id_used_at_idx" ON "free_tier_signal_trade_usages"("user_id", "used_at");

-- AddForeignKey
ALTER TABLE "free_tier_signal_trades" ADD CONSTRAINT "free_tier_signal_trades_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "free_tier_signal_trade_usages" ADD CONSTRAINT "free_tier_signal_trade_usages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "free_tier_signal_trades"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

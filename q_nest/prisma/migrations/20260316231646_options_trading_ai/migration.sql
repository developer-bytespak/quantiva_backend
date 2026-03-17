-- CreateTable
CREATE TABLE "options_iv_history" (
    "id" UUID NOT NULL,
    "underlying" VARCHAR(20) NOT NULL,
    "iv_value" DECIMAL(10,6) NOT NULL,
    "iv_rank" DECIMAL(6,4),
    "recorded_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "options_iv_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "options_signals_ai" (
    "id" UUID NOT NULL,
    "underlying" VARCHAR(20) NOT NULL,
    "strategy" VARCHAR(50) NOT NULL,
    "direction" VARCHAR(10) NOT NULL,
    "score" DECIMAL(5,4) NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "iv_rank" DECIMAL(6,4),
    "iv_value" DECIMAL(10,6),
    "spot_price" DECIMAL(20,8),
    "legs" JSON NOT NULL,
    "reasoning" TEXT,
    "risk_reward" VARCHAR(20),
    "max_profit" VARCHAR(50),
    "max_loss" VARCHAR(50),
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "options_signals_ai_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "options_iv_history_underlying_recorded_at_idx" ON "options_iv_history"("underlying", "recorded_at");

-- CreateIndex
CREATE INDEX "options_signals_ai_underlying_created_at_idx" ON "options_signals_ai"("underlying", "created_at");

-- CreateIndex
CREATE INDEX "options_signals_ai_strategy_idx" ON "options_signals_ai"("strategy");

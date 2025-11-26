-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('pending', 'approved', 'rejected', 'review');

-- CreateEnum
CREATE TYPE "RiskTolerance" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "ExchangeType" AS ENUM ('crypto', 'stocks');

-- CreateEnum
CREATE TYPE "StrategyType" AS ENUM ('admin', 'user');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "SignalAction" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('pending', 'active', 'invalid', 'revoked');

-- CreateEnum
CREATE TYPE "PortfolioType" AS ENUM ('spot', 'futures', 'margin');

-- CreateEnum
CREATE TYPE "PositionSide" AS ENUM ('long', 'short');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('market', 'limit', 'stop', 'stop_limit');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'filled', 'partially_filled', 'cancelled', 'rejected');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'cancelled', 'trial', 'expired');

-- CreateTable
CREATE TABLE "users" (
    "user_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "username" VARCHAR(100) NOT NULL,
    "password_hash" VARCHAR(255),
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "kyc_status" "KycStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "issued_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "user_id" UUID NOT NULL,
    "risk_tolerance" "RiskTolerance" NOT NULL DEFAULT 'medium',
    "notifications_email" BOOLEAN NOT NULL DEFAULT true,
    "notifications_push" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "kyc_verifications" (
    "kyc_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'pending',
    "decision_reason" TEXT,

    CONSTRAINT "kyc_verifications_pkey" PRIMARY KEY ("kyc_id")
);

-- CreateTable
CREATE TABLE "kyc_documents" (
    "document_id" UUID NOT NULL,
    "kyc_id" UUID NOT NULL,
    "storage_url" TEXT NOT NULL,
    "ocr_name" VARCHAR(255),
    "ocr_dob" DATE,
    "ocr_confidence" DECIMAL(5,4),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "kyc_face_matches" (
    "match_id" UUID NOT NULL,
    "kyc_id" UUID NOT NULL,
    "photo_url" TEXT NOT NULL,
    "similarity" DECIMAL(5,4),
    "is_match" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_face_matches_pkey" PRIMARY KEY ("match_id")
);

-- CreateTable
CREATE TABLE "exchanges" (
    "exchange_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "type" "ExchangeType" NOT NULL,
    "supports_oauth" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchanges_pkey" PRIMARY KEY ("exchange_id")
);

-- CreateTable
CREATE TABLE "user_exchange_connections" (
    "connection_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "exchange_id" UUID NOT NULL,
    "auth_type" VARCHAR(20) NOT NULL,
    "api_key_encrypted" TEXT,
    "api_secret_encrypted" TEXT,
    "oauth_access_token" TEXT,
    "oauth_refresh_token" TEXT,
    "permissions" JSON,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "user_exchange_connections_pkey" PRIMARY KEY ("connection_id")
);

-- CreateTable
CREATE TABLE "assets" (
    "asset_id" UUID NOT NULL,
    "symbol" VARCHAR(50),
    "name" VARCHAR(200),
    "asset_type" VARCHAR(20),
    "sector" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "first_seen_at" TIMESTAMP(6),
    "last_seen_at" TIMESTAMP(6),

    CONSTRAINT "assets_pkey" PRIMARY KEY ("asset_id")
);

-- CreateTable
CREATE TABLE "market_rankings" (
    "rank_timestamp" TIMESTAMP(6) NOT NULL,
    "asset_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "market_cap" DECIMAL(30,2),
    "price_usd" DECIMAL(20,8),
    "volume_24h" DECIMAL(30,2),

    CONSTRAINT "market_rankings_pkey" PRIMARY KEY ("rank_timestamp","asset_id")
);

-- CreateTable
CREATE TABLE "trending_assets" (
    "poll_timestamp" TIMESTAMP(6) NOT NULL,
    "asset_id" UUID NOT NULL,
    "trend_rank" INTEGER,
    "galaxy_score" DECIMAL(10,4),
    "alt_rank" DECIMAL(10,4),
    "social_score" DECIMAL(20,8),
    "market_volume" DECIMAL(30,10),
    "price_usd" DECIMAL(20,8),

    CONSTRAINT "trending_assets_pkey" PRIMARY KEY ("poll_timestamp","asset_id")
);

-- CreateTable
CREATE TABLE "trending_news" (
    "poll_timestamp" TIMESTAMP(6) NOT NULL,
    "asset_id" UUID NOT NULL,
    "news_score" DECIMAL(10,4),
    "news_sentiment" DECIMAL(10,4),
    "news_volume" INTEGER,
    "media_buzz" DECIMAL(10,4),
    "heading" VARCHAR(120),
    "news_detail" JSON,

    CONSTRAINT "trending_news_pkey" PRIMARY KEY ("poll_timestamp","asset_id")
);

-- CreateTable
CREATE TABLE "asset_market_data" (
    "asset_id" UUID NOT NULL,
    "timestamp" TIMESTAMP(6) NOT NULL,
    "open_price" DECIMAL(20,8),
    "high_price" DECIMAL(20,8),
    "low_price" DECIMAL(20,8),
    "close_price" DECIMAL(20,8),
    "volume" DECIMAL(30,8),

    CONSTRAINT "asset_market_data_pkey" PRIMARY KEY ("asset_id","timestamp")
);

-- CreateTable
CREATE TABLE "asset_metrics" (
    "metric_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "metric_date" DATE,
    "metric_type" VARCHAR(50),
    "metric_value" DECIMAL(30,10),

    CONSTRAINT "asset_metrics_pkey" PRIMARY KEY ("metric_id")
);

-- CreateTable
CREATE TABLE "macro_indicators" (
    "indicator_id" UUID NOT NULL,
    "code" VARCHAR(50),
    "name" VARCHAR(200),
    "category" VARCHAR(100),
    "frequency" VARCHAR(20),
    "source" VARCHAR(50),

    CONSTRAINT "macro_indicators_pkey" PRIMARY KEY ("indicator_id")
);

-- CreateTable
CREATE TABLE "macro_indicator_values" (
    "indicator_id" UUID NOT NULL,
    "data_date" DATE NOT NULL,
    "value" DECIMAL(20,6),
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "macro_indicator_values_pkey" PRIMARY KEY ("indicator_id","data_date")
);

-- CreateTable
CREATE TABLE "strategies" (
    "strategy_id" UUID NOT NULL,
    "user_id" UUID,
    "name" VARCHAR(100),
    "type" "StrategyType" NOT NULL,
    "description" TEXT,
    "risk_level" "RiskLevel" NOT NULL,
    "auto_trade_threshold" DECIMAL(5,4),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "strategies_pkey" PRIMARY KEY ("strategy_id")
);

-- CreateTable
CREATE TABLE "strategy_parameters" (
    "parameter_id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "name" VARCHAR(100),
    "value" VARCHAR(255),
    "created_at" TIMESTAMP(6),

    CONSTRAINT "strategy_parameters_pkey" PRIMARY KEY ("parameter_id")
);

-- CreateTable
CREATE TABLE "sentiment_analyses" (
    "sentiment_id" UUID NOT NULL,
    "source_type" VARCHAR(20),
    "label" VARCHAR(20),
    "score" DECIMAL(6,3),
    "confidence" DECIMAL(5,4),
    "created_at" TIMESTAMP(6),

    CONSTRAINT "sentiment_analyses_pkey" PRIMARY KEY ("sentiment_id")
);

-- CreateTable
CREATE TABLE "strategy_signals" (
    "signal_id" UUID NOT NULL,
    "strategy_id" UUID,
    "user_id" UUID,
    "asset_id" UUID,
    "timestamp" TIMESTAMP(6),
    "final_score" DECIMAL(6,3),
    "action" "SignalAction" NOT NULL,
    "confidence" DECIMAL(5,4),
    "sentiment_score" DECIMAL(6,3),
    "trend_score" DECIMAL(6,3),
    "fundamental_score" DECIMAL(6,3),
    "liquidity_score" DECIMAL(6,3),
    "event_risk_score" DECIMAL(6,3),
    "macro_score" DECIMAL(6,3),
    "volatility_score" DECIMAL(6,3),

    CONSTRAINT "strategy_signals_pkey" PRIMARY KEY ("signal_id")
);

-- CreateTable
CREATE TABLE "signal_details" (
    "detail_id" UUID NOT NULL,
    "signal_id" UUID NOT NULL,
    "entry_price" DECIMAL(20,8),
    "position_size" DECIMAL(20,8),
    "position_value" DECIMAL(20,8),
    "stop_loss" DECIMAL(20,8),
    "take_profit_1" DECIMAL(20,8),
    "take_profit_2" DECIMAL(20,8),
    "leverage" DECIMAL(6,2),
    "order_type" "OrderType",
    "time_in_force" VARCHAR(20),
    "metadata" JSON,
    "created_at" TIMESTAMP(6),

    CONSTRAINT "signal_details_pkey" PRIMARY KEY ("detail_id")
);

-- CreateTable
CREATE TABLE "signal_explanations" (
    "explanation_id" UUID NOT NULL,
    "signal_id" UUID NOT NULL,
    "llm_model" VARCHAR(50),
    "text" TEXT,
    "created_at" TIMESTAMP(6),

    CONSTRAINT "signal_explanations_pkey" PRIMARY KEY ("explanation_id")
);

-- CreateTable
CREATE TABLE "portfolios" (
    "portfolio_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(100),
    "type" "PortfolioType" NOT NULL DEFAULT 'spot',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "portfolios_pkey" PRIMARY KEY ("portfolio_id")
);

-- CreateTable
CREATE TABLE "portfolio_positions" (
    "position_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "quantity" DECIMAL(30,10),
    "avg_entry_price" DECIMAL(20,8),
    "current_price" DECIMAL(20,8),
    "unrealized_pnl" DECIMAL(20,8),
    "realized_pnl" DECIMAL(20,8),
    "leverage" DECIMAL(6,2),
    "side" "PositionSide",
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "portfolio_positions_pkey" PRIMARY KEY ("position_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "order_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "signal_id" UUID,
    "side" "SignalAction",
    "order_type" "OrderType",
    "quantity" DECIMAL(30,10),
    "price" DECIMAL(20,8),
    "status" "OrderStatus" NOT NULL DEFAULT 'pending',
    "auto_trade_approved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "order_executions" (
    "execution_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "trade_id" VARCHAR(100),
    "price" DECIMAL(20,8),
    "quantity" DECIMAL(30,10),
    "fee" DECIMAL(20,8),
    "timestamp" TIMESTAMP(6),

    CONSTRAINT "order_executions_pkey" PRIMARY KEY ("execution_id")
);

-- CreateTable
CREATE TABLE "portfolio_snapshots" (
    "snapshot_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "timestamp" TIMESTAMP(6) NOT NULL,
    "total_value" DECIMAL(30,10),
    "cash_value" DECIMAL(30,10),
    "positions_value" DECIMAL(30,10),
    "pnl_24h" DECIMAL(20,8),
    "metadata" JSON,

    CONSTRAINT "portfolio_snapshots_pkey" PRIMARY KEY ("snapshot_id")
);

-- CreateTable
CREATE TABLE "auto_trade_evaluations" (
    "evaluation_id" UUID NOT NULL,
    "signal_id" UUID NOT NULL,
    "final_score" DECIMAL(6,3),
    "confidence" DECIMAL(5,4),
    "threshold" DECIMAL(5,4),
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "evaluated_at" TIMESTAMP(6),

    CONSTRAINT "auto_trade_evaluations_pkey" PRIMARY KEY ("evaluation_id")
);

-- CreateTable
CREATE TABLE "optimization_runs" (
    "optimization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "run_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model_used" VARCHAR(50),
    "constraint_max_asset" DECIMAL(5,2),
    "constraint_max_sector" DECIMAL(5,2),
    "constraint_risk_level" "RiskLevel" NOT NULL,
    "included_signal_assets" JSON,
    "included_portfolio_assets" JSON,
    "status" VARCHAR(20),
    "log" TEXT,

    CONSTRAINT "optimization_runs_pkey" PRIMARY KEY ("optimization_id")
);

-- CreateTable
CREATE TABLE "optimization_allocations" (
    "allocation_id" UUID NOT NULL,
    "optimization_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "final_weight" DECIMAL(8,5),
    "expected_return" DECIMAL(8,5),
    "risk_score" DECIMAL(8,5),
    "sector" VARCHAR(50),

    CONSTRAINT "optimization_allocations_pkey" PRIMARY KEY ("allocation_id")
);

-- CreateTable
CREATE TABLE "rebalance_suggestions" (
    "suggestion_id" UUID NOT NULL,
    "optimization_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "current_weight" DECIMAL(8,5),
    "target_weight" DECIMAL(8,5),
    "action" VARCHAR(10),
    "generated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rebalance_suggestions_pkey" PRIMARY KEY ("suggestion_id")
);

-- CreateTable
CREATE TABLE "risk_events" (
    "risk_event_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "portfolio_id" UUID,
    "asset_id" UUID,
    "event_type" VARCHAR(50),
    "severity_level" "RiskLevel" NOT NULL,
    "triggered_by" VARCHAR(50),
    "score" DECIMAL(6,3),
    "detected_at" TIMESTAMP(6),
    "resolved_at" TIMESTAMP(6),

    CONSTRAINT "risk_events_pkey" PRIMARY KEY ("risk_event_id")
);

-- CreateTable
CREATE TABLE "drawdown_history" (
    "drawdown_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "timestamp" TIMESTAMP(6) NOT NULL,
    "equity_value" DECIMAL(20,8),
    "peak_value" DECIMAL(20,8),
    "drawdown_percent" DECIMAL(6,3),

    CONSTRAINT "drawdown_history_pkey" PRIMARY KEY ("drawdown_id")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "plan_id" UUID NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "price_monthly" DECIMAL(10,2),
    "description" TEXT,
    "features_json" JSON,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("plan_id")
);

-- CreateTable
CREATE TABLE "user_subscriptions" (
    "subscription_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "started_at" TIMESTAMP(6),
    "expires_at" TIMESTAMP(6),
    "billing_provider" VARCHAR(50),

    CONSTRAINT "user_subscriptions_pkey" PRIMARY KEY ("subscription_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");

-- CreateIndex
CREATE INDEX "kyc_verifications_user_id_idx" ON "kyc_verifications"("user_id");

-- CreateIndex
CREATE INDEX "kyc_documents_kyc_id_idx" ON "kyc_documents"("kyc_id");

-- CreateIndex
CREATE INDEX "kyc_face_matches_kyc_id_idx" ON "kyc_face_matches"("kyc_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchanges_name_key" ON "exchanges"("name");

-- CreateIndex
CREATE INDEX "user_exchange_connections_user_id_idx" ON "user_exchange_connections"("user_id");

-- CreateIndex
CREATE INDEX "user_exchange_connections_exchange_id_idx" ON "user_exchange_connections"("exchange_id");

-- CreateIndex
CREATE INDEX "asset_metrics_asset_id_idx" ON "asset_metrics"("asset_id");

-- CreateIndex
CREATE INDEX "strategies_user_id_idx" ON "strategies"("user_id");

-- CreateIndex
CREATE INDEX "strategy_parameters_strategy_id_idx" ON "strategy_parameters"("strategy_id");

-- CreateIndex
CREATE INDEX "strategy_signals_strategy_id_idx" ON "strategy_signals"("strategy_id");

-- CreateIndex
CREATE INDEX "strategy_signals_user_id_idx" ON "strategy_signals"("user_id");

-- CreateIndex
CREATE INDEX "strategy_signals_asset_id_idx" ON "strategy_signals"("asset_id");

-- CreateIndex
CREATE INDEX "signal_details_signal_id_idx" ON "signal_details"("signal_id");

-- CreateIndex
CREATE INDEX "signal_explanations_signal_id_idx" ON "signal_explanations"("signal_id");

-- CreateIndex
CREATE INDEX "portfolios_user_id_idx" ON "portfolios"("user_id");

-- CreateIndex
CREATE INDEX "portfolio_positions_portfolio_id_idx" ON "portfolio_positions"("portfolio_id");

-- CreateIndex
CREATE INDEX "portfolio_positions_asset_id_idx" ON "portfolio_positions"("asset_id");

-- CreateIndex
CREATE INDEX "orders_portfolio_id_idx" ON "orders"("portfolio_id");

-- CreateIndex
CREATE INDEX "orders_signal_id_idx" ON "orders"("signal_id");

-- CreateIndex
CREATE INDEX "order_executions_order_id_idx" ON "order_executions"("order_id");

-- CreateIndex
CREATE INDEX "portfolio_snapshots_portfolio_id_idx" ON "portfolio_snapshots"("portfolio_id");

-- CreateIndex
CREATE INDEX "auto_trade_evaluations_signal_id_idx" ON "auto_trade_evaluations"("signal_id");

-- CreateIndex
CREATE INDEX "optimization_runs_user_id_idx" ON "optimization_runs"("user_id");

-- CreateIndex
CREATE INDEX "optimization_runs_portfolio_id_idx" ON "optimization_runs"("portfolio_id");

-- CreateIndex
CREATE INDEX "optimization_allocations_optimization_id_idx" ON "optimization_allocations"("optimization_id");

-- CreateIndex
CREATE INDEX "optimization_allocations_asset_id_idx" ON "optimization_allocations"("asset_id");

-- CreateIndex
CREATE INDEX "rebalance_suggestions_optimization_id_idx" ON "rebalance_suggestions"("optimization_id");

-- CreateIndex
CREATE INDEX "rebalance_suggestions_asset_id_idx" ON "rebalance_suggestions"("asset_id");

-- CreateIndex
CREATE INDEX "risk_events_user_id_idx" ON "risk_events"("user_id");

-- CreateIndex
CREATE INDEX "drawdown_history_portfolio_id_idx" ON "drawdown_history"("portfolio_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_name_key" ON "subscription_plans"("name");

-- CreateIndex
CREATE INDEX "user_subscriptions_user_id_idx" ON "user_subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "user_subscriptions_plan_id_idx" ON "user_subscriptions"("plan_id");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_verifications" ADD CONSTRAINT "kyc_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_kyc_id_fkey" FOREIGN KEY ("kyc_id") REFERENCES "kyc_verifications"("kyc_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_face_matches" ADD CONSTRAINT "kyc_face_matches_kyc_id_fkey" FOREIGN KEY ("kyc_id") REFERENCES "kyc_verifications"("kyc_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_exchange_connections" ADD CONSTRAINT "user_exchange_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_exchange_connections" ADD CONSTRAINT "user_exchange_connections_exchange_id_fkey" FOREIGN KEY ("exchange_id") REFERENCES "exchanges"("exchange_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_rankings" ADD CONSTRAINT "market_rankings_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trending_assets" ADD CONSTRAINT "trending_assets_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trending_news" ADD CONSTRAINT "trending_news_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_market_data" ADD CONSTRAINT "asset_market_data_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_metrics" ADD CONSTRAINT "asset_metrics_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "macro_indicator_values" ADD CONSTRAINT "macro_indicator_values_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "macro_indicators"("indicator_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_parameters" ADD CONSTRAINT "strategy_parameters_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("strategy_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_signals" ADD CONSTRAINT "strategy_signals_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("strategy_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_signals" ADD CONSTRAINT "strategy_signals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_signals" ADD CONSTRAINT "strategy_signals_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_details" ADD CONSTRAINT "signal_details_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "strategy_signals"("signal_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_explanations" ADD CONSTRAINT "signal_explanations_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "strategy_signals"("signal_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_positions" ADD CONSTRAINT "portfolio_positions_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("portfolio_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_positions" ADD CONSTRAINT "portfolio_positions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("portfolio_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "strategy_signals"("signal_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_executions" ADD CONSTRAINT "order_executions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("portfolio_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_trade_evaluations" ADD CONSTRAINT "auto_trade_evaluations_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "strategy_signals"("signal_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_runs" ADD CONSTRAINT "optimization_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_runs" ADD CONSTRAINT "optimization_runs_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("portfolio_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_allocations" ADD CONSTRAINT "optimization_allocations_optimization_id_fkey" FOREIGN KEY ("optimization_id") REFERENCES "optimization_runs"("optimization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_allocations" ADD CONSTRAINT "optimization_allocations_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rebalance_suggestions" ADD CONSTRAINT "rebalance_suggestions_optimization_id_fkey" FOREIGN KEY ("optimization_id") REFERENCES "optimization_runs"("optimization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rebalance_suggestions" ADD CONSTRAINT "rebalance_suggestions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drawdown_history" ADD CONSTRAINT "drawdown_history_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("portfolio_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("plan_id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
CREATE TYPE "SignalAction" AS ENUM ('BUY', 'SELL', 'HOLD');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('pending', 'active', 'invalid', 'revoked');

-- CreateEnum
CREATE TYPE "PortfolioType" AS ENUM ('spot', 'futures', 'margin', 'options');

-- CreateEnum
CREATE TYPE "PositionSide" AS ENUM ('long', 'short');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('market', 'limit', 'stop', 'stop_limit');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'filled', 'partially_filled', 'cancelled', 'rejected');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'cancelled', 'trial', 'expired');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('pending', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "NewsSource" AS ENUM ('StockNewsAPI', 'LunarCrush');

-- CreateEnum
CREATE TYPE "SentimentLabel" AS ENUM ('positive', 'negative', 'neutral');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('FREE', 'PRO', 'ELITE', 'ELITE_PLUS');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "FeatureType" AS ENUM ('CUSTOM_STRATEGIES', 'VC_POOL_ACCESS', 'EARLY_ACCESS', 'OPTIONS_TRADING', 'TOP_TRADE_FEES');

-- CreateEnum
CREATE TYPE "TradeFeeStatus" AS ENUM ('pending', 'invoiced', 'paid', 'failed', 'waived');

-- CreateEnum
CREATE TYPE "MonthlyFeeStatus" AS ENUM ('accumulating', 'invoiced', 'paid', 'failed', 'below_minimum');

-- CreateEnum
CREATE TYPE "TradeFeeSource" AS ENUM ('top_trade_crypto', 'top_trade_stock', 'options_execution', 'options_performance');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'succeeded', 'failed', 'refunded', 'cancelled');

-- CreateEnum
CREATE TYPE "PoolStatus" AS ENUM ('draft', 'open', 'full', 'active', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "VcPaymentMethod" AS ENUM ('stripe', 'binance');

-- CreateEnum
CREATE TYPE "SeatReservationStatus" AS ENUM ('reserved', 'confirmed', 'released', 'expired');

-- CreateEnum
CREATE TYPE "PaymentSubmissionStatus" AS ENUM ('pending', 'processing', 'verified', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "ExitRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'processed');

-- CreateEnum
CREATE TYPE "PoolPayoutStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "PayoutType" AS ENUM ('completion', 'pool_cancelled');

-- CreateEnum
CREATE TYPE "BinancePaymentStatus" AS ENUM ('pending', 'verified', 'rejected', 'refunded');

-- CreateEnum
CREATE TYPE "OnboardingState" AS ENUM ('SIGNED_UP', 'PERSONAL_INFO', 'KYC', 'PAID', 'CONNECT_EXCHANGE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('QUEUED', 'SENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OptionType" AS ENUM ('CALL', 'PUT');

-- CreateEnum
CREATE TYPE "OptionOrderStatus" AS ENUM ('pending', 'filled', 'partially_filled', 'cancelled', 'rejected', 'expired', 'submitting');

-- CreateEnum
CREATE TYPE "QhqTransactionType" AS ENUM ('EARN_SUBSCRIPTION', 'EARN_TRADING', 'EARN_STRATEGY', 'EARN_BACKTEST', 'EARN_REFERRAL', 'EARN_BETA', 'EARN_LOYALTY_BONUS', 'CLAIM_TO_WALLET', 'SPEND_SUBSCRIPTION_DISCOUNT', 'SPEND_VC_FEE_REDUCTION', 'SPEND_FEATURE_UNLOCK', 'BURN_ON_SPEND', 'ADMIN_GRANT', 'ADMIN_DEDUCT');

-- CreateEnum
CREATE TYPE "QueuedTradeStatus" AS ENUM ('queued', 'submitted', 'filled', 'canceled', 'expired', 'failed');

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
    "two_factor_enabled" BOOLEAN NOT NULL DEFAULT true,
    "two_factor_secret" VARCHAR(255),
    "dob" DATE,
    "full_name" VARCHAR(120),
    "gender" VARCHAR(50),
    "nationality" VARCHAR(100),
    "phone_number" VARCHAR(20),
    "profile_pic_url" TEXT,
    "current_tier" "PlanTier" NOT NULL DEFAULT 'FREE',
    "stripe_connect_account_id" VARCHAR(255),
    "binance_deposit_address" VARCHAR(255),
    "fcm_token" VARCHAR(512),
    "stripe_customer_id" VARCHAR(255),
    "onboarding_emails_opted_out" BOOLEAN NOT NULL DEFAULT false,
    "onboarding_state" "OnboardingState" NOT NULL DEFAULT 'SIGNED_UP',

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "issued_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "device_id" VARCHAR(255),
    "ip_address" VARCHAR(45),
    "refresh_token_hash" TEXT,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "two_factor_codes" (
    "code_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code" VARCHAR(6) NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "purpose" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_codes_pkey" PRIMARY KEY ("code_id")
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
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(6),
    "metadata" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" VARCHAR(100) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_verifications" (
    "kyc_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'pending',
    "decision_reason" TEXT,
    "doc_authenticity_score" DECIMAL(5,4),
    "face_match_score" DECIMAL(5,4),
    "liveness_confidence" DECIMAL(5,4),
    "liveness_result" VARCHAR(20),
    "mrz_data" JSON,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sumsub_applicant_id" VARCHAR(255),
    "sumsub_external_user_id" VARCHAR(255),
    "sumsub_review_result" JSON,
    "sumsub_review_status" VARCHAR(50),
    "updated_at" TIMESTAMP(6),
    "verification_provider" VARCHAR(20) NOT NULL DEFAULT 'sumsub',
    "review_reject_type" VARCHAR(10),

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
    "authenticity_flags" JSON,
    "document_type" VARCHAR(50),
    "expiration_date" DATE,
    "issuing_country" VARCHAR(100),
    "mrz_text" TEXT,
    "document_side" VARCHAR(10),
    "is_primary" BOOLEAN NOT NULL DEFAULT true,

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
    "liveness_confidence" DECIMAL(5,4),
    "liveness_result" VARCHAR(20),
    "quality_score" DECIMAL(5,4),
    "spoof_type" VARCHAR(50),

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
    "connection_metadata" JSON,
    "last_synced_at" TIMESTAMP(6),

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
    "coingecko_id" VARCHAR(100),
    "display_name" VARCHAR(255),
    "logo_url" TEXT,
    "market_cap_rank" INTEGER,
    "available_exchanges" JSONB,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("asset_id")
);

-- CreateTable
CREATE TABLE "coin_details" (
    "coin_detail_id" UUID NOT NULL,
    "coingecko_id" VARCHAR(100) NOT NULL,
    "symbol" VARCHAR(50) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "homepage_url" VARCHAR(500),
    "image_url" VARCHAR(500),
    "market_cap_rank" INTEGER,
    "market_cap_usd" DECIMAL(30,2),
    "fully_diluted_valuation_usd" DECIMAL(30,2),
    "circulating_supply" DECIMAL(30,8),
    "total_supply" DECIMAL(30,8),
    "max_supply" DECIMAL(30,8),
    "ath_usd" DECIMAL(20,8),
    "ath_date" TIMESTAMP(6),
    "atl_usd" DECIMAL(20,8),
    "atl_date" TIMESTAMP(6),
    "total_volume_24h" DECIMAL(30,2),
    "current_price_usd" DECIMAL(20,8),
    "price_change_24h" DECIMAL(20,8),
    "price_change_percentage_24h" DECIMAL(10,4),
    "last_updated" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_details_pkey" PRIMARY KEY ("coin_detail_id")
);

-- CreateTable
CREATE TABLE "market_rankings" (
    "rank_timestamp" TIMESTAMP(6) NOT NULL,
    "asset_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "market_cap" DECIMAL(30,2),
    "price_usd" DECIMAL(20,8),
    "volume_24h" DECIMAL(30,2),
    "change_24h" DECIMAL(20,8),
    "change_percent_24h" DECIMAL(10,4),

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
    "high_24h" DECIMAL(20,8),
    "low_24h" DECIMAL(20,8),
    "market_cap" DECIMAL(30,2),
    "price_change_24h" DECIMAL(10,4),
    "price_change_24h_usd" DECIMAL(20,8),
    "volume_24h" DECIMAL(30,10),
    "ai_insight" TEXT,
    "ai_insight_strategy_id" UUID,
    "insight_generated_at" TIMESTAMP(6),

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
    "article_url" TEXT,
    "metadata" JSON,
    "published_at" TIMESTAMP(6),
    "sentiment_label" "SentimentLabel",
    "source" "NewsSource",

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
    "metadata" JSON,
    "source" VARCHAR(50),

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
    "entry_rules" JSONB,
    "exit_rules" JSONB,
    "indicators" JSONB,
    "schedule_cron" VARCHAR(100),
    "stop_loss_type" VARCHAR(20),
    "stop_loss_value" DECIMAL(10,4),
    "take_profit_type" VARCHAR(20),
    "take_profit_value" DECIMAL(10,4),
    "target_assets" JSONB,
    "timeframe" VARCHAR(20),
    "engine_weights" JSONB,
    "template_id" UUID,
    "asset_type" TEXT,

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
    "engine_metadata" JSON,

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
    "error_message" TEXT,
    "explanation_status" VARCHAR(20),
    "retry_count" INTEGER NOT NULL DEFAULT 0,

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
    "metadata" JSON,

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
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "base_price" DECIMAL(10,2),
    "billing_period" "BillingPeriod" NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discount_percent" DECIMAL(5,2) DEFAULT 0,
    "display_order" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "price" DECIMAL(10,2) NOT NULL,
    "tier" "PlanTier" NOT NULL,
    "updated_at" TIMESTAMP(6),

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
    "auto_renew" BOOLEAN NOT NULL DEFAULT true,
    "billing_period" "BillingPeriod" NOT NULL,
    "cancelled_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current_period_end" TIMESTAMP(6),
    "current_period_start" TIMESTAMP(6),
    "external_id" VARCHAR(255),
    "last_payment_date" TIMESTAMP(6),
    "next_billing_date" TIMESTAMP(6),
    "tier" "PlanTier" NOT NULL,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "user_subscriptions_pkey" PRIMARY KEY ("subscription_id")
);

-- CreateTable
CREATE TABLE "strategy_execution_jobs" (
    "job_id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'pending',
    "scheduled_at" TIMESTAMP(6) NOT NULL,
    "started_at" TIMESTAMP(6),
    "completed_at" TIMESTAMP(6),
    "error_message" TEXT,

    CONSTRAINT "strategy_execution_jobs_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "sentiment_ema_state" (
    "asset_id" VARCHAR(100) NOT NULL,
    "ema_value" DOUBLE PRECISION NOT NULL,
    "last_timestamp" TIMESTAMP(6) NOT NULL,
    "momentum" DOUBLE PRECISION,
    "raw_score" DOUBLE PRECISION,
    "metadata" JSON,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sentiment_ema_state_pkey" PRIMARY KEY ("asset_id")
);

-- CreateTable
CREATE TABLE "plan_features" (
    "feature_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "feature_type" "FeatureType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "limit_value" INTEGER,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "plan_features_pkey" PRIMARY KEY ("feature_id")
);

-- CreateTable
CREATE TABLE "subscription_usage" (
    "usage_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "feature_type" "FeatureType" NOT NULL,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "period_start" TIMESTAMP(6) NOT NULL,
    "period_end" TIMESTAMP(6) NOT NULL,
    "details" JSON,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "subscription_usage_pkey" PRIMARY KEY ("usage_id")
);

-- CreateTable
CREATE TABLE "payment_history" (
    "payment_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "payment_provider" VARCHAR(50),
    "external_payment_id" VARCHAR(255),
    "payment_method" VARCHAR(50),
    "invoice_url" TEXT,
    "receipt_url" TEXT,
    "failure_reason" TEXT,
    "paid_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "payment_history_pkey" PRIMARY KEY ("payment_id")
);

-- CreateTable
CREATE TABLE "onboarding_email_reminders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "onboarding_state" "OnboardingState" NOT NULL,
    "delay_label" VARCHAR(10) NOT NULL,
    "bull_job_id" VARCHAR(255) NOT NULL,
    "status" "ReminderStatus" NOT NULL DEFAULT 'QUEUED',
    "scheduled_at" TIMESTAMP(6) NOT NULL,
    "sent_at" TIMESTAMP(6),
    "cancelled_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_email_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admins" (
    "admin_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "full_name" VARCHAR(120),
    "stripe_secret_key_encrypted" TEXT,
    "stripe_publishable_key" VARCHAR(255),
    "stripe_webhook_secret_encrypted" TEXT,
    "binance_uid" VARCHAR(100),
    "binance_api_key_encrypted" TEXT,
    "binance_api_secret_encrypted" TEXT,
    "default_pool_fee_percent" DECIMAL(5,2) NOT NULL DEFAULT 5.00,
    "default_admin_profit_fee_percent" DECIMAL(5,2) NOT NULL DEFAULT 20.00,
    "default_cancellation_fee_percent" DECIMAL(5,2) NOT NULL DEFAULT 5.00,
    "default_payment_window_minutes" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    "payment_network" VARCHAR(50) DEFAULT 'BSC',
    "wallet_address" VARCHAR(255),
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("admin_id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "session_id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "issued_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "device_id" VARCHAR(255),
    "ip_address" VARCHAR(45),
    "refresh_token_hash" TEXT,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "vc_pools" (
    "pool_id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "coin_type" VARCHAR(10) NOT NULL DEFAULT 'USDT',
    "contribution_amount" DECIMAL(20,8) NOT NULL,
    "max_members" INTEGER NOT NULL,
    "pool_fee_percent" DECIMAL(5,2) NOT NULL,
    "admin_profit_fee_percent" DECIMAL(5,2) NOT NULL,
    "cancellation_fee_percent" DECIMAL(5,2) NOT NULL,
    "payment_window_minutes" INTEGER NOT NULL DEFAULT 30,
    "duration_days" INTEGER NOT NULL,
    "status" "PoolStatus" NOT NULL DEFAULT 'draft',
    "started_at" TIMESTAMP(6),
    "end_date" TIMESTAMP(6),
    "is_replica" BOOLEAN NOT NULL DEFAULT false,
    "original_pool_id" UUID,
    "verified_members_count" INTEGER NOT NULL DEFAULT 0,
    "reserved_seats_count" INTEGER NOT NULL DEFAULT 0,
    "total_invested_usdt" DECIMAL(20,8),
    "current_pool_value_usdt" DECIMAL(20,8),
    "total_profit_usdt" DECIMAL(20,8),
    "total_pool_fees_usdt" DECIMAL(20,8),
    "admin_fee_earned_usdt" DECIMAL(20,8),
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    "completed_at" TIMESTAMP(6),
    "cancelled_at" TIMESTAMP(6),

    CONSTRAINT "vc_pools_pkey" PRIMARY KEY ("pool_id")
);

-- CreateTable
CREATE TABLE "vc_pool_seat_reservations" (
    "reservation_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "payment_method" "VcPaymentMethod" NOT NULL,
    "reserved_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "status" "SeatReservationStatus" NOT NULL DEFAULT 'reserved',

    CONSTRAINT "vc_pool_seat_reservations_pkey" PRIMARY KEY ("reservation_id")
);

-- CreateTable
CREATE TABLE "vc_pool_payment_submissions" (
    "submission_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "payment_method" "VcPaymentMethod" NOT NULL,
    "investment_amount" DECIMAL(20,8) NOT NULL,
    "pool_fee_amount" DECIMAL(20,8) NOT NULL,
    "total_amount" DECIMAL(20,8) NOT NULL,
    "stripe_checkout_session_id" VARCHAR(255),
    "stripe_payment_intent_id" VARCHAR(255),
    "screenshot_url" TEXT,
    "admin_notes" VARCHAR(500),
    "status" "PaymentSubmissionStatus" NOT NULL DEFAULT 'pending',
    "payment_deadline" TIMESTAMP(6) NOT NULL,
    "rejection_reason" VARCHAR(500),
    "reviewed_by_admin_id" UUID,
    "verified_at" TIMESTAMP(6),
    "submitted_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "binance_amount_received_usdt" DECIMAL(20,8),
    "binance_payment_status" "BinancePaymentStatus" NOT NULL DEFAULT 'pending',
    "binance_tx_id" VARCHAR(255),
    "binance_tx_timestamp" TIMESTAMP(6),
    "exact_amount_expected" DECIMAL(20,8),
    "exact_amount_received" DECIMAL(20,8),
    "refund_initiated_at" TIMESTAMP(6),
    "refund_reason" VARCHAR(500),
    "tx_hash" VARCHAR(255),
    "user_wallet_address" VARCHAR(255),

    CONSTRAINT "vc_pool_payment_submissions_pkey" PRIMARY KEY ("submission_id")
);

-- CreateTable
CREATE TABLE "vc_pool_members" (
    "member_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "payment_method" "VcPaymentMethod" NOT NULL,
    "invested_amount_usdt" DECIMAL(20,8) NOT NULL,
    "share_percent" DECIMAL(8,5) NOT NULL,
    "user_binance_uid" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "joined_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exited_at" TIMESTAMP(6),
    "user_wallet_address" VARCHAR(255),

    CONSTRAINT "vc_pool_members_pkey" PRIMARY KEY ("member_id")
);

-- CreateTable
CREATE TABLE "vc_pool_trades" (
    "trade_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "strategy_id" UUID,
    "admin_id" UUID NOT NULL,
    "asset_pair" VARCHAR(20) NOT NULL,
    "action" "SignalAction" NOT NULL,
    "quantity" DECIMAL(30,10) NOT NULL,
    "entry_price_usdt" DECIMAL(20,8) NOT NULL,
    "exit_price_usdt" DECIMAL(20,8),
    "pnl_usdt" DECIMAL(20,8),
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "binance_order_id" VARCHAR(100),
    "notes" TEXT,
    "traded_at" TIMESTAMP(6) NOT NULL,
    "closed_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vc_pool_trades_pkey" PRIMARY KEY ("trade_id")
);

-- CreateTable
CREATE TABLE "vc_pool_exchange_orders" (
    "order_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "symbol" VARCHAR(20) NOT NULL,
    "side" VARCHAR(10) NOT NULL,
    "order_type" VARCHAR(20) NOT NULL,
    "quantity" DECIMAL(30,10) NOT NULL,
    "entry_price_usdt" DECIMAL(20,8) NOT NULL,
    "exchange_order_id" VARCHAR(100),
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "exit_price_usdt" DECIMAL(20,8),
    "realized_pnl_usdt" DECIMAL(20,8),
    "opened_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vc_pool_exchange_orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "vc_pool_cancellations" (
    "cancellation_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "pool_status_at_request" "PoolStatus" NOT NULL,
    "invested_amount" DECIMAL(20,8) NOT NULL,
    "share_percent_at_exit" DECIMAL(8,5),
    "pool_value_at_exit" DECIMAL(20,8),
    "member_value_at_exit" DECIMAL(20,8) NOT NULL,
    "cancellation_fee_pct" DECIMAL(5,2) NOT NULL,
    "fee_amount" DECIMAL(20,8) NOT NULL,
    "refund_amount" DECIMAL(20,8) NOT NULL,
    "stripe_refund_id" VARCHAR(255),
    "stripe_transfer_id" VARCHAR(255),
    "binance_refund_tx_id" VARCHAR(255),
    "status" "ExitRequestStatus" NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_admin_id" UUID,
    "reviewed_at" TIMESTAMP(6),
    "rejection_reason" VARCHAR(500),
    "refunded_at" TIMESTAMP(6),

    CONSTRAINT "vc_pool_cancellations_pkey" PRIMARY KEY ("cancellation_id")
);

-- CreateTable
CREATE TABLE "vc_pool_payouts" (
    "payout_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "payout_type" "PayoutType" NOT NULL,
    "initial_investment" DECIMAL(20,8) NOT NULL,
    "share_percent" DECIMAL(8,5) NOT NULL,
    "pool_final_value" DECIMAL(20,8),
    "gross_payout" DECIMAL(20,8) NOT NULL,
    "admin_fee_deducted" DECIMAL(20,8) NOT NULL,
    "net_payout" DECIMAL(20,8) NOT NULL,
    "profit_loss" DECIMAL(20,8) NOT NULL,
    "stripe_refund_id" VARCHAR(255),
    "stripe_transfer_id" VARCHAR(255),
    "binance_tx_id" VARCHAR(255),
    "status" "PoolPayoutStatus" NOT NULL DEFAULT 'pending',
    "paid_at" TIMESTAMP(6),
    "notes" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vc_pool_payouts_pkey" PRIMARY KEY ("payout_id")
);

-- CreateTable
CREATE TABLE "vc_pool_transactions" (
    "transaction_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "payment_submission_id" UUID,
    "member_id" UUID,
    "transaction_type" VARCHAR(50) NOT NULL,
    "amount_usdt" DECIMAL(20,8) NOT NULL,
    "description" TEXT,
    "binance_tx_id" VARCHAR(255),
    "binance_tx_timestamp" TIMESTAMP(6),
    "expected_amount" DECIMAL(20,8),
    "actual_amount_received" DECIMAL(20,8),
    "status" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(6),

    CONSTRAINT "vc_pool_transactions_pkey" PRIMARY KEY ("transaction_id")
);

-- CreateTable
CREATE TABLE "user_credits" (
    "credit_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credit_amount_usdt" DECIMAL(20,8) NOT NULL,
    "source" VARCHAR(50) NOT NULL,
    "is_spent" BOOLEAN NOT NULL DEFAULT false,
    "spent_on_pool_id" UUID,
    "spent_amount" DECIMAL(20,8),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "spent_at" TIMESTAMP(6),

    CONSTRAINT "user_credits_pkey" PRIMARY KEY ("credit_id")
);

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

-- CreateTable
CREATE TABLE "options_iv_history" (
    "id" UUID NOT NULL,
    "underlying" VARCHAR(20) NOT NULL,
    "iv_value" DECIMAL(10,6) NOT NULL,
    "iv_rank" DECIMAL(6,4),
    "recorded_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "iv_percentile" DECIMAL(6,4),

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

-- CreateTable
CREATE TABLE "trade_fees" (
    "fee_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "trade_reference_id" VARCHAR(255),
    "asset_symbol" VARCHAR(50) NOT NULL,
    "trade_side" VARCHAR(10) NOT NULL,
    "trade_value_usd" DECIMAL(18,4) NOT NULL,
    "fee_percent" DECIMAL(8,6) NOT NULL DEFAULT 0.001,
    "fee_amount_usd" DECIMAL(18,6) NOT NULL,
    "status" "TradeFeeStatus" NOT NULL DEFAULT 'pending',
    "source" "TradeFeeSource" NOT NULL DEFAULT 'top_trade_crypto',
    "billing_month" VARCHAR(7) NOT NULL,
    "stripe_invoice_item_id" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_fees_pkey" PRIMARY KEY ("fee_id")
);

-- CreateTable
CREATE TABLE "monthly_fee_summaries" (
    "summary_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "billing_month" VARCHAR(7) NOT NULL,
    "total_trades" INTEGER NOT NULL DEFAULT 0,
    "total_trade_volume_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_fees_usd" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "status" "MonthlyFeeStatus" NOT NULL DEFAULT 'accumulating',
    "stripe_invoice_id" VARCHAR(255),
    "paid_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "monthly_fee_summaries_pkey" PRIMARY KEY ("summary_id")
);

-- CreateTable
CREATE TABLE "qhq_token_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "total_supply" DECIMAL(30,18) NOT NULL DEFAULT 100000000,
    "circulating_supply" DECIMAL(30,18) NOT NULL DEFAULT 0,
    "total_burned" DECIMAL(30,18) NOT NULL DEFAULT 0,
    "contract_address" VARCHAR(42),
    "network" VARCHAR(20) NOT NULL DEFAULT 'base',
    "current_merkle_root" VARCHAR(66),
    "merkle_last_updated" TIMESTAMP(6),
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "qhq_token_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qhq_balances" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "pending_balance" DECIMAL(30,18) NOT NULL DEFAULT 0,
    "cumulative_earned" DECIMAL(30,18) NOT NULL DEFAULT 0,
    "lifetime_claimed" DECIMAL(30,18) NOT NULL DEFAULT 0,
    "lifetime_spent" DECIMAL(30,18) NOT NULL DEFAULT 0,
    "lifetime_burned" DECIMAL(30,18) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "qhq_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qhq_transactions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "QhqTransactionType" NOT NULL,
    "amount" DECIMAL(30,18) NOT NULL,
    "balance_after" DECIMAL(30,18) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "reference_id" VARCHAR(255),
    "tx_hash" VARCHAR(66),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qhq_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qhq_wallet_links" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "wallet_address" VARCHAR(42) NOT NULL,
    "network" VARCHAR(20) NOT NULL DEFAULT 'base',
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "linked_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qhq_wallet_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qhq_reward_rules" (
    "id" UUID NOT NULL,
    "rule_key" VARCHAR(100) NOT NULL,
    "amount" DECIMAL(30,18) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "description" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "qhq_reward_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qhq_subscription_discounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "qhq_spent" DECIMAL(30,18) NOT NULL,
    "discount_percent" INTEGER NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "applied_at" TIMESTAMP(6),
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qhq_subscription_discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_submissions" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "company" VARCHAR(100),
    "phone" VARCHAR(20),
    "subject" VARCHAR(50) NOT NULL,
    "message" TEXT NOT NULL,
    "source" VARCHAR(20) NOT NULL DEFAULT 'homepage',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_submissions_pkey" PRIMARY KEY ("id")
);

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
    "buy_filled_at" TIMESTAMP(6),
    "protection_attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pending_queued_trades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_current_tier_idx" ON "users"("current_tier");

-- CreateIndex
CREATE INDEX "users_onboarding_state_idx" ON "users"("onboarding_state");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");

-- CreateIndex
CREATE INDEX "two_factor_codes_user_id_idx" ON "two_factor_codes"("user_id");

-- CreateIndex
CREATE INDEX "two_factor_codes_expires_at_idx" ON "two_factor_codes"("expires_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_idx" ON "notifications"("user_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_idx" ON "notifications"("user_id", "read");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_type_idx" ON "notifications"("type");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_verifications_sumsub_applicant_id_key" ON "kyc_verifications"("sumsub_applicant_id");

-- CreateIndex
CREATE INDEX "kyc_verifications_user_id_idx" ON "kyc_verifications"("user_id");

-- CreateIndex
CREATE INDEX "kyc_verifications_sumsub_applicant_id_idx" ON "kyc_verifications"("sumsub_applicant_id");

-- CreateIndex
CREATE INDEX "kyc_verifications_sumsub_external_user_id_idx" ON "kyc_verifications"("sumsub_external_user_id");

-- CreateIndex
CREATE INDEX "kyc_verifications_verification_provider_idx" ON "kyc_verifications"("verification_provider");

-- CreateIndex
CREATE INDEX "kyc_documents_kyc_id_idx" ON "kyc_documents"("kyc_id");

-- CreateIndex
CREATE INDEX "kyc_documents_kyc_id_document_type_document_side_idx" ON "kyc_documents"("kyc_id", "document_type", "document_side");

-- CreateIndex
CREATE INDEX "kyc_face_matches_kyc_id_idx" ON "kyc_face_matches"("kyc_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchanges_name_key" ON "exchanges"("name");

-- CreateIndex
CREATE INDEX "user_exchange_connections_user_id_idx" ON "user_exchange_connections"("user_id");

-- CreateIndex
CREATE INDEX "user_exchange_connections_exchange_id_idx" ON "user_exchange_connections"("exchange_id");

-- CreateIndex
CREATE INDEX "user_exchange_connections_status_idx" ON "user_exchange_connections"("status");

-- CreateIndex
CREATE INDEX "user_exchange_connections_user_id_status_idx" ON "user_exchange_connections"("user_id", "status");

-- CreateIndex
CREATE INDEX "assets_asset_type_is_active_idx" ON "assets"("asset_type", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "assets_symbol_asset_type_key" ON "assets"("symbol", "asset_type");

-- CreateIndex
CREATE UNIQUE INDEX "coin_details_coingecko_id_key" ON "coin_details"("coingecko_id");

-- CreateIndex
CREATE INDEX "coin_details_symbol_idx" ON "coin_details"("symbol");

-- CreateIndex
CREATE INDEX "coin_details_last_updated_idx" ON "coin_details"("last_updated");

-- CreateIndex
CREATE INDEX "coin_details_market_cap_rank_idx" ON "coin_details"("market_cap_rank");

-- CreateIndex
CREATE INDEX "trending_assets_asset_id_poll_timestamp_idx" ON "trending_assets"("asset_id", "poll_timestamp");

-- CreateIndex
CREATE INDEX "asset_metrics_asset_id_idx" ON "asset_metrics"("asset_id");

-- CreateIndex
CREATE INDEX "strategies_user_id_idx" ON "strategies"("user_id");

-- CreateIndex
CREATE INDEX "strategies_is_active_idx" ON "strategies"("is_active");

-- CreateIndex
CREATE INDEX "strategies_template_id_idx" ON "strategies"("template_id");

-- CreateIndex
CREATE INDEX "strategy_parameters_strategy_id_idx" ON "strategy_parameters"("strategy_id");

-- CreateIndex
CREATE INDEX "strategy_signals_strategy_id_idx" ON "strategy_signals"("strategy_id");

-- CreateIndex
CREATE INDEX "strategy_signals_user_id_idx" ON "strategy_signals"("user_id");

-- CreateIndex
CREATE INDEX "strategy_signals_asset_id_idx" ON "strategy_signals"("asset_id");

-- CreateIndex
CREATE INDEX "strategy_signals_strategy_id_timestamp_idx" ON "strategy_signals"("strategy_id", "timestamp");

-- CreateIndex
CREATE INDEX "strategy_signals_strategy_id_asset_id_timestamp_idx" ON "strategy_signals"("strategy_id", "asset_id", "timestamp");

-- CreateIndex
CREATE INDEX "strategy_signals_user_id_timestamp_idx" ON "strategy_signals"("user_id", "timestamp");

-- CreateIndex
CREATE INDEX "strategy_signals_asset_id_timestamp_idx" ON "strategy_signals"("asset_id", "timestamp");

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
CREATE INDEX "subscription_plans_tier_idx" ON "subscription_plans"("tier");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_tier_billing_period_key" ON "subscription_plans"("tier", "billing_period");

-- CreateIndex
CREATE INDEX "user_subscriptions_user_id_idx" ON "user_subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "user_subscriptions_plan_id_idx" ON "user_subscriptions"("plan_id");

-- CreateIndex
CREATE INDEX "user_subscriptions_status_idx" ON "user_subscriptions"("status");

-- CreateIndex
CREATE INDEX "user_subscriptions_current_period_end_idx" ON "user_subscriptions"("current_period_end");

-- CreateIndex
CREATE INDEX "strategy_execution_jobs_strategy_id_idx" ON "strategy_execution_jobs"("strategy_id");

-- CreateIndex
CREATE INDEX "strategy_execution_jobs_status_idx" ON "strategy_execution_jobs"("status");

-- CreateIndex
CREATE INDEX "strategy_execution_jobs_scheduled_at_idx" ON "strategy_execution_jobs"("scheduled_at");

-- CreateIndex
CREATE INDEX "plan_features_plan_id_idx" ON "plan_features"("plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_features_plan_id_feature_type_key" ON "plan_features"("plan_id", "feature_type");

-- CreateIndex
CREATE INDEX "subscription_usage_subscription_id_idx" ON "subscription_usage"("subscription_id");

-- CreateIndex
CREATE INDEX "subscription_usage_user_id_idx" ON "subscription_usage"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_usage_subscription_id_feature_type_period_star_key" ON "subscription_usage"("subscription_id", "feature_type", "period_start");

-- CreateIndex
CREATE INDEX "payment_history_user_id_idx" ON "payment_history"("user_id");

-- CreateIndex
CREATE INDEX "payment_history_subscription_id_idx" ON "payment_history"("subscription_id");

-- CreateIndex
CREATE INDEX "payment_history_status_idx" ON "payment_history"("status");

-- CreateIndex
CREATE INDEX "onboarding_email_reminders_user_id_status_idx" ON "onboarding_email_reminders"("user_id", "status");

-- CreateIndex
CREATE INDEX "onboarding_email_reminders_user_id_onboarding_state_idx" ON "onboarding_email_reminders"("user_id", "onboarding_state");

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");

-- CreateIndex
CREATE INDEX "admin_sessions_admin_id_idx" ON "admin_sessions"("admin_id");

-- CreateIndex
CREATE INDEX "vc_pools_admin_id_idx" ON "vc_pools"("admin_id");

-- CreateIndex
CREATE INDEX "vc_pools_status_idx" ON "vc_pools"("status");

-- CreateIndex
CREATE INDEX "vc_pools_is_archived_idx" ON "vc_pools"("is_archived");

-- CreateIndex
CREATE INDEX "vc_pool_seat_reservations_pool_id_idx" ON "vc_pool_seat_reservations"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_seat_reservations_user_id_idx" ON "vc_pool_seat_reservations"("user_id");

-- CreateIndex
CREATE INDEX "vc_pool_seat_reservations_status_idx" ON "vc_pool_seat_reservations"("status");

-- CreateIndex
CREATE INDEX "vc_pool_seat_reservations_expires_at_idx" ON "vc_pool_seat_reservations"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_seat_reservations_pool_id_user_id_key" ON "vc_pool_seat_reservations"("pool_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_payment_submissions_reservation_id_key" ON "vc_pool_payment_submissions"("reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_payment_submissions_stripe_payment_intent_id_key" ON "vc_pool_payment_submissions"("stripe_payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_payment_submissions_binance_tx_id_key" ON "vc_pool_payment_submissions"("binance_tx_id");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_payment_submissions_tx_hash_key" ON "vc_pool_payment_submissions"("tx_hash");

-- CreateIndex
CREATE INDEX "vc_pool_payment_submissions_pool_id_idx" ON "vc_pool_payment_submissions"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_payment_submissions_user_id_idx" ON "vc_pool_payment_submissions"("user_id");

-- CreateIndex
CREATE INDEX "vc_pool_payment_submissions_status_idx" ON "vc_pool_payment_submissions"("status");

-- CreateIndex
CREATE INDEX "vc_pool_payment_submissions_stripe_payment_intent_id_idx" ON "vc_pool_payment_submissions"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "vc_pool_payment_submissions_binance_payment_status_idx" ON "vc_pool_payment_submissions"("binance_payment_status");

-- CreateIndex
CREATE INDEX "vc_pool_members_pool_id_idx" ON "vc_pool_members"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_members_user_id_idx" ON "vc_pool_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_members_pool_id_user_id_key" ON "vc_pool_members"("pool_id", "user_id");

-- CreateIndex
CREATE INDEX "vc_pool_trades_pool_id_idx" ON "vc_pool_trades"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_trades_strategy_id_idx" ON "vc_pool_trades"("strategy_id");

-- CreateIndex
CREATE INDEX "vc_pool_trades_is_open_idx" ON "vc_pool_trades"("is_open");

-- CreateIndex
CREATE INDEX "vc_pool_trades_pool_id_strategy_id_idx" ON "vc_pool_trades"("pool_id", "strategy_id");

-- CreateIndex
CREATE INDEX "vc_pool_exchange_orders_pool_id_idx" ON "vc_pool_exchange_orders"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_exchange_orders_pool_id_is_open_idx" ON "vc_pool_exchange_orders"("pool_id", "is_open");

-- CreateIndex
CREATE INDEX "vc_pool_exchange_orders_admin_id_idx" ON "vc_pool_exchange_orders"("admin_id");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_cancellations_member_id_key" ON "vc_pool_cancellations"("member_id");

-- CreateIndex
CREATE INDEX "vc_pool_cancellations_pool_id_idx" ON "vc_pool_cancellations"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_cancellations_member_id_idx" ON "vc_pool_cancellations"("member_id");

-- CreateIndex
CREATE INDEX "vc_pool_cancellations_status_idx" ON "vc_pool_cancellations"("status");

-- CreateIndex
CREATE INDEX "vc_pool_payouts_pool_id_idx" ON "vc_pool_payouts"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_payouts_member_id_idx" ON "vc_pool_payouts"("member_id");

-- CreateIndex
CREATE INDEX "vc_pool_payouts_status_idx" ON "vc_pool_payouts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_transactions_payment_submission_id_key" ON "vc_pool_transactions"("payment_submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "vc_pool_transactions_binance_tx_id_key" ON "vc_pool_transactions"("binance_tx_id");

-- CreateIndex
CREATE INDEX "vc_pool_transactions_pool_id_idx" ON "vc_pool_transactions"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_transactions_user_id_idx" ON "vc_pool_transactions"("user_id");

-- CreateIndex
CREATE INDEX "vc_pool_transactions_status_idx" ON "vc_pool_transactions"("status");

-- CreateIndex
CREATE INDEX "vc_pool_transactions_created_at_idx" ON "vc_pool_transactions"("created_at");

-- CreateIndex
CREATE INDEX "vc_pool_transactions_binance_tx_id_idx" ON "vc_pool_transactions"("binance_tx_id");

-- CreateIndex
CREATE INDEX "user_credits_user_id_idx" ON "user_credits"("user_id");

-- CreateIndex
CREATE INDEX "user_credits_is_spent_idx" ON "user_credits"("is_spent");

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

-- CreateIndex
CREATE INDEX "options_iv_history_underlying_recorded_at_idx" ON "options_iv_history"("underlying", "recorded_at");

-- CreateIndex
CREATE INDEX "options_signals_ai_underlying_created_at_idx" ON "options_signals_ai"("underlying", "created_at");

-- CreateIndex
CREATE INDEX "options_signals_ai_strategy_idx" ON "options_signals_ai"("strategy");

-- CreateIndex
CREATE INDEX "trade_fees_user_id_billing_month_idx" ON "trade_fees"("user_id", "billing_month");

-- CreateIndex
CREATE INDEX "trade_fees_status_idx" ON "trade_fees"("status");

-- CreateIndex
CREATE INDEX "monthly_fee_summaries_status_idx" ON "monthly_fee_summaries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_fee_summaries_user_id_billing_month_key" ON "monthly_fee_summaries"("user_id", "billing_month");

-- CreateIndex
CREATE UNIQUE INDEX "qhq_balances_user_id_key" ON "qhq_balances"("user_id");

-- CreateIndex
CREATE INDEX "qhq_transactions_user_id_created_at_idx" ON "qhq_transactions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "qhq_transactions_type_idx" ON "qhq_transactions"("type");

-- CreateIndex
CREATE UNIQUE INDEX "qhq_wallet_links_user_id_key" ON "qhq_wallet_links"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "qhq_wallet_links_wallet_address_key" ON "qhq_wallet_links"("wallet_address");

-- CreateIndex
CREATE INDEX "qhq_wallet_links_wallet_address_idx" ON "qhq_wallet_links"("wallet_address");

-- CreateIndex
CREATE UNIQUE INDEX "qhq_reward_rules_rule_key_key" ON "qhq_reward_rules"("rule_key");

-- CreateIndex
CREATE INDEX "qhq_subscription_discounts_user_id_applied_idx" ON "qhq_subscription_discounts"("user_id", "applied");

-- CreateIndex
CREATE INDEX "contact_submissions_user_id_idx" ON "contact_submissions"("user_id");

-- CreateIndex
CREATE INDEX "contact_submissions_created_at_idx" ON "contact_submissions"("created_at");

-- CreateIndex
CREATE INDEX "pending_queued_trades_user_id_idx" ON "pending_queued_trades"("user_id");

-- CreateIndex
CREATE INDEX "pending_queued_trades_connection_id_idx" ON "pending_queued_trades"("connection_id");

-- CreateIndex
CREATE INDEX "pending_queued_trades_status_idx" ON "pending_queued_trades"("status");

-- CreateIndex
CREATE INDEX "pending_queued_trades_user_id_status_idx" ON "pending_queued_trades"("user_id", "status");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_codes" ADD CONSTRAINT "two_factor_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_verifications" ADD CONSTRAINT "kyc_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_kyc_id_fkey" FOREIGN KEY ("kyc_id") REFERENCES "kyc_verifications"("kyc_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_face_matches" ADD CONSTRAINT "kyc_face_matches_kyc_id_fkey" FOREIGN KEY ("kyc_id") REFERENCES "kyc_verifications"("kyc_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_exchange_connections" ADD CONSTRAINT "user_exchange_connections_exchange_id_fkey" FOREIGN KEY ("exchange_id") REFERENCES "exchanges"("exchange_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_exchange_connections" ADD CONSTRAINT "user_exchange_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "strategies"("strategy_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_parameters" ADD CONSTRAINT "strategy_parameters_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("strategy_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_signals" ADD CONSTRAINT "strategy_signals_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_signals" ADD CONSTRAINT "strategy_signals_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("strategy_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_signals" ADD CONSTRAINT "strategy_signals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_details" ADD CONSTRAINT "signal_details_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "strategy_signals"("signal_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_explanations" ADD CONSTRAINT "signal_explanations_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "strategy_signals"("signal_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_positions" ADD CONSTRAINT "portfolio_positions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_positions" ADD CONSTRAINT "portfolio_positions_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("portfolio_id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "optimization_runs" ADD CONSTRAINT "optimization_runs_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("portfolio_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_runs" ADD CONSTRAINT "optimization_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_allocations" ADD CONSTRAINT "optimization_allocations_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_allocations" ADD CONSTRAINT "optimization_allocations_optimization_id_fkey" FOREIGN KEY ("optimization_id") REFERENCES "optimization_runs"("optimization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rebalance_suggestions" ADD CONSTRAINT "rebalance_suggestions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("asset_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rebalance_suggestions" ADD CONSTRAINT "rebalance_suggestions_optimization_id_fkey" FOREIGN KEY ("optimization_id") REFERENCES "optimization_runs"("optimization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drawdown_history" ADD CONSTRAINT "drawdown_history_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("portfolio_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("plan_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_execution_jobs" ADD CONSTRAINT "strategy_execution_jobs_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("strategy_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("plan_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_usage" ADD CONSTRAINT "subscription_usage_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "user_subscriptions"("subscription_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_usage" ADD CONSTRAINT "subscription_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_history" ADD CONSTRAINT "payment_history_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "user_subscriptions"("subscription_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_history" ADD CONSTRAINT "payment_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_email_reminders" ADD CONSTRAINT "onboarding_email_reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("admin_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pools" ADD CONSTRAINT "vc_pools_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pools" ADD CONSTRAINT "vc_pools_original_pool_id_fkey" FOREIGN KEY ("original_pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_seat_reservations" ADD CONSTRAINT "vc_pool_seat_reservations_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_seat_reservations" ADD CONSTRAINT "vc_pool_seat_reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_payment_submissions" ADD CONSTRAINT "vc_pool_payment_submissions_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_payment_submissions" ADD CONSTRAINT "vc_pool_payment_submissions_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "vc_pool_seat_reservations"("reservation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_payment_submissions" ADD CONSTRAINT "vc_pool_payment_submissions_reviewed_by_admin_id_fkey" FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "admins"("admin_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_payment_submissions" ADD CONSTRAINT "vc_pool_payment_submissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_members" ADD CONSTRAINT "vc_pool_members_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_members" ADD CONSTRAINT "vc_pool_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_trades" ADD CONSTRAINT "vc_pool_trades_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_trades" ADD CONSTRAINT "vc_pool_trades_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_trades" ADD CONSTRAINT "vc_pool_trades_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("strategy_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_exchange_orders" ADD CONSTRAINT "vc_pool_exchange_orders_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_exchange_orders" ADD CONSTRAINT "vc_pool_exchange_orders_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_cancellations" ADD CONSTRAINT "vc_pool_cancellations_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "vc_pool_members"("member_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_cancellations" ADD CONSTRAINT "vc_pool_cancellations_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_cancellations" ADD CONSTRAINT "vc_pool_cancellations_reviewed_by_admin_id_fkey" FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "admins"("admin_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_payouts" ADD CONSTRAINT "vc_pool_payouts_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "vc_pool_members"("member_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_payouts" ADD CONSTRAINT "vc_pool_payouts_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_transactions" ADD CONSTRAINT "vc_pool_transactions_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "vc_pool_members"("member_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_transactions" ADD CONSTRAINT "vc_pool_transactions_payment_submission_id_fkey" FOREIGN KEY ("payment_submission_id") REFERENCES "vc_pool_payment_submissions"("submission_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_transactions" ADD CONSTRAINT "vc_pool_transactions_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_transactions" ADD CONSTRAINT "vc_pool_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_credits" ADD CONSTRAINT "user_credits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "options_orders" ADD CONSTRAINT "options_orders_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "strategy_signals"("signal_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "options_orders" ADD CONSTRAINT "options_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "options_positions" ADD CONSTRAINT "options_positions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "options_orders"("order_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "options_positions" ADD CONSTRAINT "options_positions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "options_signals" ADD CONSTRAINT "options_signals_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "strategy_signals"("signal_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_fees" ADD CONSTRAINT "trade_fees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_fee_summaries" ADD CONSTRAINT "monthly_fee_summaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qhq_balances" ADD CONSTRAINT "qhq_balances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qhq_transactions" ADD CONSTRAINT "qhq_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qhq_wallet_links" ADD CONSTRAINT "qhq_wallet_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_submissions" ADD CONSTRAINT "contact_submissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;


-- CreateEnum
CREATE TYPE "QhqTransactionType" AS ENUM ('EARN_SUBSCRIPTION', 'EARN_TRADING', 'EARN_STRATEGY', 'EARN_BACKTEST', 'EARN_REFERRAL', 'EARN_BETA', 'EARN_LOYALTY_BONUS', 'CLAIM_TO_WALLET', 'SPEND_SUBSCRIPTION_DISCOUNT', 'SPEND_VC_FEE_REDUCTION', 'SPEND_FEATURE_UNLOCK', 'BURN_ON_SPEND', 'ADMIN_GRANT', 'ADMIN_DEDUCT');

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

-- AddForeignKey
ALTER TABLE "qhq_balances" ADD CONSTRAINT "qhq_balances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qhq_transactions" ADD CONSTRAINT "qhq_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qhq_wallet_links" ADD CONSTRAINT "qhq_wallet_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

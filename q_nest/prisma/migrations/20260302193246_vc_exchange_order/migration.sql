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

-- CreateIndex
CREATE INDEX "vc_pool_exchange_orders_pool_id_idx" ON "vc_pool_exchange_orders"("pool_id");

-- CreateIndex
CREATE INDEX "vc_pool_exchange_orders_pool_id_is_open_idx" ON "vc_pool_exchange_orders"("pool_id", "is_open");

-- CreateIndex
CREATE INDEX "vc_pool_exchange_orders_admin_id_idx" ON "vc_pool_exchange_orders"("admin_id");

-- AddForeignKey
ALTER TABLE "vc_pool_exchange_orders" ADD CONSTRAINT "vc_pool_exchange_orders_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "vc_pools"("pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vc_pool_exchange_orders" ADD CONSTRAINT "vc_pool_exchange_orders_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("admin_id") ON DELETE RESTRICT ON UPDATE CASCADE;

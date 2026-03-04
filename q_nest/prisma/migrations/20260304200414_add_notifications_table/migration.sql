-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('kyc_approved', 'kyc_rejected', 'kyc_under_review', 'seat_reserved', 'payment_verified', 'payment_rejected', 'seat_released_timeout', 'pool_full', 'payout_processed', 'share_credited', 'order_filled', 'order_cancelled', 'order_failed', 'new_signal', 'two_fa_code_sent', 'new_login_detected', 'password_changed', 'exchange_connected', 'exchange_connection_failed', 'plan_activated', 'payment_successful', 'payment_failed', 'important_alert_news');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(6),
    "metadata" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_idx" ON "notifications"("user_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_idx" ON "notifications"("user_id", "read");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_type_idx" ON "notifications"("type");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

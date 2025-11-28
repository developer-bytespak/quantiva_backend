-- AlterTable
ALTER TABLE "user_exchange_connections" ADD COLUMN     "connection_metadata" JSON,
ADD COLUMN     "last_synced_at" TIMESTAMP(6);

-- CreateIndex
CREATE INDEX "user_exchange_connections_status_idx" ON "user_exchange_connections"("status");

-- CreateIndex
CREATE INDEX "user_exchange_connections_user_id_status_idx" ON "user_exchange_connections"("user_id", "status");

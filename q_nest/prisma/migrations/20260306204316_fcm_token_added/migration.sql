-- AlterTable
ALTER TABLE "users" ADD COLUMN     "fcm_token" VARCHAR(512);

-- CreateIndex
CREATE INDEX "notifications_type_idx" ON "notifications"("type");

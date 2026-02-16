/*
  Warnings:

  - A unique constraint covering the columns `[subscription_id,feature_type,period_start]` on the table `subscription_usage` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "subscription_usage_subscription_id_feature_type_key";

-- CreateIndex
CREATE UNIQUE INDEX "subscription_usage_subscription_id_feature_type_period_star_key" ON "subscription_usage"("subscription_id", "feature_type", "period_start");

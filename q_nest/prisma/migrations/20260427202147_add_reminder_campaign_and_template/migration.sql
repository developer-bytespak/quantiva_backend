/*
  Warnings:

  - Added the required column `template_name` to the `onboarding_email_reminders` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ReminderCampaign" AS ENUM ('FUNNEL', 'FREE_UPGRADE');

-- AlterTable
ALTER TABLE "onboarding_email_reminders" ADD COLUMN     "campaign" "ReminderCampaign" NOT NULL DEFAULT 'FUNNEL',
ADD COLUMN     "template_name" VARCHAR(64) NOT NULL;

-- CreateIndex
CREATE INDEX "onboarding_email_reminders_user_id_campaign_idx" ON "onboarding_email_reminders"("user_id", "campaign");

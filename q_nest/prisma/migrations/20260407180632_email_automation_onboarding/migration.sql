-- CreateEnum
CREATE TYPE "OnboardingState" AS ENUM ('SIGNED_UP', 'PERSONAL_INFO', 'KYC', 'PAID', 'CONNECT_EXCHANGE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('QUEUED', 'SENT', 'CANCELLED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "onboarding_emails_opted_out" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "onboarding_state" "OnboardingState" NOT NULL DEFAULT 'SIGNED_UP';

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

-- CreateIndex
CREATE INDEX "onboarding_email_reminders_user_id_status_idx" ON "onboarding_email_reminders"("user_id", "status");

-- CreateIndex
CREATE INDEX "onboarding_email_reminders_user_id_onboarding_state_idx" ON "onboarding_email_reminders"("user_id", "onboarding_state");

-- CreateIndex
CREATE INDEX "users_onboarding_state_idx" ON "users"("onboarding_state");

-- AddForeignKey
ALTER TABLE "onboarding_email_reminders" ADD CONSTRAINT "onboarding_email_reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('pending', 'running', 'completed', 'failed');

-- AlterTable
ALTER TABLE "strategies" ADD COLUMN     "entry_rules" JSONB,
ADD COLUMN     "exit_rules" JSONB,
ADD COLUMN     "indicators" JSONB,
ADD COLUMN     "schedule_cron" VARCHAR(100),
ADD COLUMN     "stop_loss_type" VARCHAR(20),
ADD COLUMN     "stop_loss_value" DECIMAL(10,4),
ADD COLUMN     "take_profit_type" VARCHAR(20),
ADD COLUMN     "take_profit_value" DECIMAL(10,4),
ADD COLUMN     "target_assets" JSONB,
ADD COLUMN     "timeframe" VARCHAR(20);

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

-- CreateIndex
CREATE INDEX "strategy_execution_jobs_strategy_id_idx" ON "strategy_execution_jobs"("strategy_id");

-- CreateIndex
CREATE INDEX "strategy_execution_jobs_status_idx" ON "strategy_execution_jobs"("status");

-- CreateIndex
CREATE INDEX "strategy_execution_jobs_scheduled_at_idx" ON "strategy_execution_jobs"("scheduled_at");

-- CreateIndex
CREATE INDEX "strategies_is_active_idx" ON "strategies"("is_active");

-- AddForeignKey
ALTER TABLE "strategy_execution_jobs" ADD CONSTRAINT "strategy_execution_jobs_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("strategy_id") ON DELETE RESTRICT ON UPDATE CASCADE;

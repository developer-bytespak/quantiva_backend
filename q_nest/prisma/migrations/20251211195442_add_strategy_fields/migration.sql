-- AlterTable
ALTER TABLE "signal_explanations" ADD COLUMN     "error_message" TEXT,
ADD COLUMN     "explanation_status" VARCHAR(20),
ADD COLUMN     "retry_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "strategies" ADD COLUMN     "engine_weights" JSONB,
ADD COLUMN     "template_id" UUID;

-- CreateIndex
CREATE INDEX "strategies_template_id_idx" ON "strategies"("template_id");

-- AddForeignKey
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "strategies"("strategy_id") ON DELETE SET NULL ON UPDATE CASCADE;

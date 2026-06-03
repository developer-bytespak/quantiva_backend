-- AlterTable
ALTER TABLE "strategies" ADD COLUMN     "target_index_code" VARCHAR(20);

-- CreateIndex
CREATE INDEX "strategies_target_index_code_idx" ON "strategies"("target_index_code");

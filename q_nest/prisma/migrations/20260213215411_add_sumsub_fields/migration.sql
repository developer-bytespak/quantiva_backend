/*
  Warnings:

  - A unique constraint covering the columns `[sumsub_applicant_id]` on the table `kyc_verifications` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "kyc_verifications" ADD COLUMN     "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "sumsub_applicant_id" VARCHAR(255),
ADD COLUMN     "sumsub_external_user_id" VARCHAR(255),
ADD COLUMN     "sumsub_review_result" JSON,
ADD COLUMN     "sumsub_review_status" VARCHAR(50),
ADD COLUMN     "updated_at" TIMESTAMP(6),
ADD COLUMN     "verification_provider" VARCHAR(20) NOT NULL DEFAULT 'sumsub';

-- CreateIndex
CREATE UNIQUE INDEX "kyc_verifications_sumsub_applicant_id_key" ON "kyc_verifications"("sumsub_applicant_id");

-- CreateIndex
CREATE INDEX "kyc_verifications_sumsub_applicant_id_idx" ON "kyc_verifications"("sumsub_applicant_id");

-- CreateIndex
CREATE INDEX "kyc_verifications_sumsub_external_user_id_idx" ON "kyc_verifications"("sumsub_external_user_id");

-- CreateIndex
CREATE INDEX "kyc_verifications_verification_provider_idx" ON "kyc_verifications"("verification_provider");

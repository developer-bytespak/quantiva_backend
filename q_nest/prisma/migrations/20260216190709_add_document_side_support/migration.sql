-- AlterTable
ALTER TABLE "kyc_documents" ADD COLUMN     "document_side" VARCHAR(10),
ADD COLUMN     "is_primary" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "kyc_documents_kyc_id_document_type_document_side_idx" ON "kyc_documents"("kyc_id", "document_type", "document_side");

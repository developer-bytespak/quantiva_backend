-- AlterTable
ALTER TABLE "kyc_documents" ADD COLUMN     "authenticity_flags" JSON,
ADD COLUMN     "document_type" VARCHAR(50),
ADD COLUMN     "expiration_date" DATE,
ADD COLUMN     "issuing_country" VARCHAR(100),
ADD COLUMN     "mrz_text" TEXT;

-- AlterTable
ALTER TABLE "kyc_face_matches" ADD COLUMN     "liveness_confidence" DECIMAL(5,4),
ADD COLUMN     "liveness_result" VARCHAR(20),
ADD COLUMN     "quality_score" DECIMAL(5,4),
ADD COLUMN     "spoof_type" VARCHAR(50);

-- AlterTable
ALTER TABLE "kyc_verifications" ADD COLUMN     "doc_authenticity_score" DECIMAL(5,4),
ADD COLUMN     "face_match_score" DECIMAL(5,4),
ADD COLUMN     "liveness_confidence" DECIMAL(5,4),
ADD COLUMN     "liveness_result" VARCHAR(20),
ADD COLUMN     "mrz_data" JSON;

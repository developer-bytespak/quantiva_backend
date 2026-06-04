/*
  Warnings:

  - You are about to drop the `kyc_documents` table. KYC document images are no
    longer stored by QuantivaHQ — Sumsub is the system of record for KYC.
  - You are about to drop the `kyc_face_matches` table. KYC face-match data is no
    longer stored by QuantivaHQ — Sumsub is the system of record for KYC.

*/
-- DropForeignKey
ALTER TABLE "kyc_documents" DROP CONSTRAINT "kyc_documents_kyc_id_fkey";

-- DropForeignKey
ALTER TABLE "kyc_face_matches" DROP CONSTRAINT "kyc_face_matches_kyc_id_fkey";

-- DropTable
DROP TABLE "kyc_documents";

-- DropTable
DROP TABLE "kyc_face_matches";

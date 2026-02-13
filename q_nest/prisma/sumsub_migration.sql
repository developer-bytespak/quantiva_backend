-- Sumsub Integration Database Migration
-- These changes will be applied when you run: npx prisma migrate dev --name add_sumsub_fields

-- Add Sumsub fields to kyc_verifications table
ALTER TABLE kyc_verifications
ADD COLUMN sumsub_applicant_id VARCHAR(255) UNIQUE,
ADD COLUMN sumsub_external_user_id VARCHAR(255),
ADD COLUMN sumsub_review_result JSON,
ADD COLUMN sumsub_review_status VARCHAR(50),
ADD COLUMN verification_provider VARCHAR(20) DEFAULT 'sumsub',
ADD COLUMN created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN updated_at TIMESTAMP(6);

-- Create indexes for performance
CREATE INDEX idx_kyc_verifications_sumsub_applicant_id ON kyc_verifications(sumsub_applicant_id);
CREATE INDEX idx_kyc_verifications_sumsub_external_user_id ON kyc_verifications(sumsub_external_user_id);
CREATE INDEX idx_kyc_verifications_verification_provider ON kyc_verifications(verification_provider);

-- Optional: Backfill existing records as DeepFace verifications
-- This marks all existing verifications as using the old DeepFace system
-- Uncomment and run AFTER migration if you want to distinguish old from new
/*
UPDATE kyc_verifications
SET verification_provider = 'deepface'
WHERE sumsub_applicant_id IS NULL
  AND verification_provider = 'sumsub';
*/

-- Query to check migration success
SELECT 
  kyc_id,
  user_id,
  status,
  verification_provider,
  sumsub_applicant_id,
  sumsub_review_status,
  created_at
FROM kyc_verifications
ORDER BY created_at DESC
LIMIT 10;

-- Query to count verifications by provider
SELECT 
  verification_provider,
  status,
  COUNT(*) as count
FROM kyc_verifications
GROUP BY verification_provider, status
ORDER BY verification_provider, status;

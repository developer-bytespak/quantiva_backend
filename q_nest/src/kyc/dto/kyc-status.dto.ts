import { KycStatus } from '@prisma/client';

export class KycStatusDto {
  status: KycStatus;
  kyc_id?: string;
  decision_reason?: string;
  liveness_result?: string;
  liveness_confidence?: number;
  face_match_score?: number;
  doc_authenticity_score?: number;
  /** Sumsub rejection type: "RETRY" (temporary, user can resubmit) or "FINAL" (permanent) */
  review_reject_type?: string;
  /** Human-readable rejection reasons (from Sumsub moderation states / buttonIds) */
  rejection_reasons?: string[];
}


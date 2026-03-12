export class RequestCancellationDto {
  reason?: string; // Optional cancellation reason from user
}

export class ApproveCancellationDto {
  adminNotes?: string; // Admin's approval notes
}

export class RejectCancellationDto {
  rejection_reason: string; // Why admin rejected
}

export class CancellationResponseDto {
  cancellation_id: string;
  pool_id: string;
  user_id: string;
  status: string; // 'pending' | 'approved' | 'rejected' | 'processed'
  
  // Fee breakdown
  contribution_amount: string; // Original invested amount
  pool_fee_amount: string; // Fee deducted at join
  cancellation_fee_amount: string; // Cancellation fee
  refund_amount: string; // What user gets back
  
  // Timestamps
  requested_at: string;
  approved_at: string | null;
  refund_completed_at: string | null;
  
  // Wallet & TX
  user_wallet_address: string | null;
  refund_tx_hash?: string | null;
  
  // Rejection
  rejection_reason: string | null;
}

export interface OCRResponse {
  name?: string;
  dob?: string;
  id_number?: string;
  nationality?: string;
  expiration_date?: string;
  mrz_text?: string;
  confidence: number;
  raw_text?: string;
}

export interface LivenessResponse {
  liveness: 'live' | 'spoof' | 'unclear';
  confidence: number;
  spoof_type?: 'photo' | 'screen' | 'mask' | 'deepfake' | null;
  quality_score?: number;
}

export interface FaceMatchResponse {
  similarity: number;
  is_match: boolean;
  confidence: number;
}

export interface DocumentAuthenticityResponse {
  is_authentic: boolean;
  authenticity_score: number;
  flags: {
    hologram_detected?: boolean;
    texture_consistent?: boolean;
    tamper_detected?: boolean;
    uv_pattern_valid?: boolean;
    font_consistent?: boolean;
  };
}


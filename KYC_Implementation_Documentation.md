# KYC Implementation Documentation

## Overview
This document provides a complete guide to the KYC (Know Your Customer) implementation in the QuantivaHQ application. This includes all files, code, API endpoints, and flow logic needed to recreate the exact same implementation.

## File Structure

```
src/
├── lib/
│   ├── api/
│   │   ├── kyc.ts                      # KYC API service
│   │   └── types/
│   │       └── kyc.ts                  # KYC type definitions
│   └── auth/
│       └── flow-router.service.ts      # Onboarding flow logic
└── app/
    └── (auth)/
        └── onboarding/
            ├── proof-upload/
            │   └── page.tsx            # Document upload page
            ├── selfie-capture/
            │   └── page.tsx            # Selfie capture page
            └── verification-status/
                └── page.tsx            # Status tracking page
```

## API Implementation

### 1. Type Definitions (`src/lib/api/types/kyc.ts`)

```typescript
/**
 * Type definitions for KYC API responses
 * These match the backend response interfaces
 */

export type KycStatus = "pending" | "approved" | "rejected" | "review";

export interface DocumentUploadResponse {
  success: boolean;
  document_id: string;
  message: string;
}

export interface KycStatusResponse {
  status: KycStatus;
  kyc_id: string | null;
  decision_reason?: string;
  liveness_result?: string;
  liveness_confidence?: number;
  face_match_score?: number;
  doc_authenticity_score?: number;
}

export interface VerificationDetails {
  kyc_id: string;
  user_id: string;
  status: KycStatus;
  decision_reason?: string;
  liveness_result?: string;
  liveness_confidence?: number;
  face_match_score?: number;
  doc_authenticity_score?: number;
  mrz_data?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
  user?: {
    user_id: string;
    email: string;
    username: string;
  };
  documents?: Array<{
    document_id: string;
    kyc_id: string;
    storage_url: string;
    document_type?: string;
    ocr_name?: string;
    ocr_dob?: string;
    ocr_confidence?: number;
    mrz_text?: string;
    authenticity_flags?: Record<string, unknown>;
    expiration_date?: string;
    issuing_country?: string;
  }>;
  face_matches?: Array<{
    match_id: string;
    kyc_id: string;
    storage_url: string;
    liveness_result?: string;
    liveness_confidence?: number;
    quality_score?: number;
    spoof_type?: string;
  }>;
}
```

### 2. KYC API Service (`src/lib/api/kyc.ts`)

```typescript
/**
 * KYC API Service
 * Centralized functions for KYC operations
 */
import { apiRequest, uploadFile } from "./client";
import type {
  DocumentUploadResponse,
  KycStatusResponse,
  VerificationDetails,
} from "./types/kyc";

/**
 * Upload ID document for KYC verification
 */
export async function uploadDocument(
  file: File,
  documentType: string
): Promise<DocumentUploadResponse> {
  return uploadFile<DocumentUploadResponse>({
    path: "/kyc/documents",
    file,
    additionalData: {
      document_type: documentType,
    },
  });
}

/**
 * Upload selfie for liveness detection and face matching
 */
export async function uploadSelfie(file: File): Promise<void> {
  await uploadFile({
    path: "/kyc/selfie",
    file,
  });
}

/**
 * Submit complete KYC verification
 */
export async function submitVerification(): Promise<void> {
  await apiRequest<void, void>({
    path: "/kyc/submit",
    method: "POST",
  });
}

/**
 * Get current KYC status for the authenticated user
 */
export async function getKycStatus(): Promise<KycStatusResponse> {
  return apiRequest<void, KycStatusResponse>({
    path: "/kyc/status",
    method: "GET",
  });
}

/**
 * Get detailed verification information by KYC ID
 */
export async function getVerificationDetails(
  kycId: string
): Promise<VerificationDetails> {
  return apiRequest<void, VerificationDetails>({
    path: `/kyc/verification/${kycId}`,
    method: "GET",
  });
}
```

## API Endpoints Used

The KYC implementation makes calls to these backend endpoints:

1. **POST `/kyc/documents`**
   - Uploads ID document (passport, driver's license, national ID)
   - Accepts file upload with document type
   - Returns `document_id` for tracking

2. **POST `/kyc/selfie`**
   - Uploads selfie for liveness detection and face matching
   - Triggers automated verification processes

3. **POST `/kyc/submit`**
   - Submits KYC for final review (optional step)
   - Marks the KYC process as complete for review

4. **GET `/kyc/status`**
   - Returns current KYC status and verification details
   - Used for status polling and progress tracking

5. **GET `/kyc/verification/{kycId}`**
   - Returns detailed verification information
   - Includes document analysis results and confidence scores

## Flow Logic (`src/lib/auth/flow-router.service.ts`)

```typescript
/**
 * Flow Router Service
 * Centralized logic for determining the next step in the onboarding/authentication flow
 * Single source of truth for post-authentication redirects
 */

import { getCurrentUser } from "../api/user";
import { getKycStatus } from "../api/kyc";
import { exchangesService } from "../api/exchanges.service";

export type FlowRoute =
  | "/onboarding/personal-info"
  | "/onboarding/proof-upload"
  | "/onboarding/verification-status"
  | "/onboarding/account-type"
  | "/dashboard";

export interface FlowCheckResult {
  route: FlowRoute;
  reason: string;
}

/**
 * Determines the next route after authentication based on user state
 * Flow logic:
 * 1. Check KYC status:
 *    - No KYC record → Check personal info, if missing go to /onboarding/personal-info
 *    - No KYC record + has personal info → /onboarding/proof-upload (start KYC)
 *    - KYC pending/review → /onboarding/verification-status
 *    - KYC approved → Continue to step 2
 * 2. Check exchange connection:
 *    - No connection → /onboarding/account-type
 *    - Has connection → /dashboard
 */
export async function determineNextRoute(): Promise<FlowCheckResult> {
  try {
    // Check if this is a new signup (always show personal-info for new signups)
    const isNewSignup = typeof window !== "undefined" && 
                        localStorage.getItem("quantivahq_is_new_signup") === "true";
    
    if (isNewSignup) {
      // Clear the flag after checking
      localStorage.removeItem("quantivahq_is_new_signup");
      return {
        route: "/onboarding/personal-info",
        reason: "New signup - collecting personal info",
      };
    }

    // Step 1: Check KYC status
    const currentUser = await getCurrentUser();
    
    // Check if personal info is complete (required before KYC)
    if (!currentUser.full_name || !currentUser.dob || !currentUser.nationality) {
      return {
        route: "/onboarding/personal-info",
        reason: "Personal information not completed",
      };
    }

    // Step 1: Check KYC status
    let kycStatus: "pending" | "approved" | "rejected" | "review" | null =
      currentUser.kyc_status || null;
    let hasKycRecord = false;
    let kycId: string | null = null;

    // If kyc_status is not available, try to get it from KYC endpoint
    if (!kycStatus || kycStatus === null) {
      try {
        const kycResponse = await getKycStatus();
        kycStatus = kycResponse.status;
        kycId = kycResponse.kyc_id;
        hasKycRecord = true;
      } catch (kycError: any) {
        // If KYC endpoint returns 404 or error, user hasn't started KYC
        if (
          kycError.message?.includes("404") ||
          kycError.message?.includes("not found")
        ) {
          hasKycRecord = false;
          kycStatus = null;
        } else {
          console.log("Error checking KYC status:", kycError);
          // On error, assume no KYC record
          kycStatus = null;
        }
      }
    } else {
      // If we have kyc_status, assume KYC record exists
      hasKycRecord = true;
    }

    const isKycApproved = kycStatus === "approved";

    if (!isKycApproved) {
      // KYC is not approved, check if KYC record exists
      if (hasKycRecord && kycId) {
        // Check if documents have been uploaded
        try {
          const { getVerificationDetails } = await import("../api/kyc");
          const verification = await getVerificationDetails(kycId);
          
          const hasDocuments = verification.documents && verification.documents.length > 0;
          const hasFaceMatch = verification.face_matches && verification.face_matches.length > 0;
          
          if (!hasDocuments || !hasFaceMatch) {
            // KYC record exists but no documents uploaded yet
            return {
              route: "/onboarding/proof-upload",
              reason: "KYC record exists but documents not uploaded",
            };
          }
          
          // Documents uploaded, show verification status
          return {
            route: "/onboarding/verification-status",
            reason: "KYC documents uploaded, pending verification",
          };
        } catch (verifyError) {
          console.log("Error checking verification details:", verifyError);
          // If we can't get verification details, default to proof upload
          return {
            route: "/onboarding/proof-upload",
            reason: "Cannot verify document upload status",
          };
        }
      } else {
        // No KYC record, start KYC flow
        return {
          route: "/onboarding/proof-upload",
          reason: "No KYC record found, starting KYC process",
        };
      }
    }

    // Step 2: Check exchange connection (only if KYC is approved)
    let hasActiveConnection = false;
    try {
      const connectionResponse = await exchangesService.getActiveConnection();
      hasActiveConnection =
        connectionResponse.success &&
        connectionResponse.data !== null &&
        connectionResponse.data.status === "active";
    } catch (connectionError) {
      // No active connection found
      console.log("No active exchange connection found");
    }

    if (!hasActiveConnection) {
      return {
        route: "/onboarding/account-type",
        reason: "KYC approved but no exchange connection",
      };
    }

    // All checks passed - user is fully onboarded
    return {
      route: "/dashboard",
      reason: "User is fully onboarded with KYC approved and exchange connected",
    };
  } catch (error: any) {
    // If checks fail, default to proof-upload (KYC start)
    console.error("[FlowRouter] Could not verify user status:", error);
    
    // If it's a 401/unauthorized error, user needs to re-authenticate
    if (error?.status === 401 || error?.statusCode === 401 || 
        error?.message?.includes("401") || error?.message?.includes("Unauthorized")) {
      console.error("[FlowRouter] User not authenticated - cookies may not be set properly");
      console.error("[FlowRouter] This may be due to:");
      console.error("  - Cookies not being sent (check sameSite/secure settings)");
      console.error("  - CORS credentials not enabled");
      console.error("  - Backend cookie settings mismatch with frontend");
      // Re-throw the error so calling code knows authentication failed
      throw error;
    }
    
    return {
      route: "/onboarding/personal-info",
      reason: "Error checking user status, defaulting to personal info",
    };
  }
}

/**
 * Navigate to the next route in the flow
 * This is a convenience function that can be used with Next.js router
 */
export async function navigateToNextRoute(
  router: { push: (path: string) => void }
): Promise<void> {
  const result = await determineNextRoute();
  console.log(`Flow router: ${result.reason} → ${result.route}`);
  router.push(result.route);
}
```

## Frontend Components

### 1. Proof Upload Page

Location: `src/app/(auth)/onboarding/proof-upload/page.tsx`

**Key Features:**
- Document type selection (ID card, passport, driver's license)
- Drag & drop file upload
- File validation (type, size)
- Image preview with modal
- PDF document support
- Progress tracking (50% completion)
- Error handling and retry logic

**Core Functions:**
```typescript
// File upload handling
const handleFileSelect = useCallback((file: File) => {
  // Validate file type and size
  // Create preview for images
  // Update state
});

// Form submission
const handleSubmit = async (e: React.FormEvent) => {
  // Upload document via API
  // Store metadata in localStorage  
  // Navigate to selfie capture
};
```

### 2. Selfie Capture Page

Location: `src/app/(auth)/onboarding/selfie-capture/page.tsx`

**Key Features:**
- Camera permission handling
- Live video stream from front camera
- Photo capture from video stream
- Face overlay guide for positioning
- Retake functionality
- Progress tracking (75% completion)
- Camera error handling

**Core Functions:**
```typescript
// Camera initialization
const startCamera = useCallback(async () => {
  // Request camera permission
  // Setup video stream
  // Handle errors
});

// Photo capture
const capturePhoto = useCallback(() => {
  // Draw video frame to canvas
  // Convert to base64 data URL
  // Update state
});

// Submit selfie
const handleSubmit = async () => {
  // Convert data URL to File
  // Upload via API
  // Navigate to verification status
};
```

### 3. Verification Status Page

Location: `src/app/(auth)/onboarding/verification-status/page.tsx`

**Key Features:**
- Real-time status polling (every 5 seconds)
- Progress visualization
- Status badges (pending, approved, rejected, review)
- Detailed verification metrics display
- Auto-redirect on approval
- Retry functionality for rejected cases

**Core Functions:**
```typescript
// Status checking with polling
const checkStatus = async () => {
  // Fetch KYC status
  // Update UI state
  // Handle auto-redirect
};

// Polling setup
useEffect(() => {
  // Initial check
  // Setup interval for pending status
  // Cleanup on unmount
}, []);
```

## KYC Flow Summary

### Step-by-Step Process

1. **Personal Information** (prerequisite)
   - User provides basic personal details
   - Required before KYC can start

2. **Document Upload** (`/onboarding/proof-upload`)
   - User selects document type
   - Uploads clear photo/scan of ID
   - API call: `POST /kyc/documents`
   - Progress: 50%

3. **Selfie Capture** (`/onboarding/selfie-capture`)
   - User grants camera permission
   - Takes live selfie for verification
   - API call: `POST /kyc/selfie`
   - Progress: 75%

4. **Verification Status** (`/onboarding/verification-status`)
   - System processes documents
   - Polls for status updates: `GET /kyc/status`
   - Shows verification metrics
   - Progress: 100% when approved

5. **Flow Continuation**
   - Approved: Continue to exchange connection
   - Rejected: Retry from document upload
   - Review: Wait for manual review

### Status States

- **pending**: Initial processing state
- **review**: Manual review required
- **approved**: Verification successful
- **rejected**: Verification failed, retry needed

### Data Storage

**localStorage Keys:**
- `quantivahq_proof_upload`: Document metadata
- `quantivahq_selfie`: Selfie data and timestamp
- `quantivahq_verification_status`: Current status cache

### Error Handling

1. **Network Errors**: Retry mechanisms with user feedback
2. **File Validation**: Size/type checks before upload
3. **Camera Errors**: Permission prompts and fallbacks
4. **API Errors**: Graceful degradation with localStorage fallbacks

### Integration Points

1. **User Authentication**: Requires valid session
2. **Flow Router**: Determines next onboarding step
3. **Exchange Connection**: Next step after KYC approval
4. **Dashboard**: Final destination after full onboarding

## Backend Requirements

The frontend expects these backend capabilities:

1. **Document Processing**
   - OCR text extraction
   - Document authenticity checks
   - Expiration date validation

2. **Liveness Detection**
   - Selfie analysis for real person
   - Anti-spoofing measures
   - Quality scoring

3. **Face Matching**
   - Compare selfie to ID document photo
   - Confidence scoring
   - Match validation

4. **Status Management**
   - Real-time status updates
   - Detailed verification results
   - Decision reasoning

## Dependencies

Required imports and dependencies:

```typescript
// Next.js
import { useRouter } from "next/navigation";

// React hooks
import { useState, useRef, useEffect, useCallback } from "react";

// API services
import { uploadDocument, uploadSelfie, getKycStatus, submitVerification } from "@/lib/api/kyc";
import { getCurrentUser } from "@/lib/api/user";

// Components
import { QuantivaLogo } from "@/components/common/quantiva-logo";

// Types
import type { KycStatus } from "@/lib/api/types/kyc";
```

This documentation provides everything needed to recreate the KYC implementation exactly as designed. All code snippets, API endpoints, flow logic, and component structures are included for complete replication.
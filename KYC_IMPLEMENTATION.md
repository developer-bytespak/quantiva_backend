# KYC Implementation Documentation

## Overview

This document describes the complete KYC (Know Your Customer) verification system implementation in the Quantiva backend. The system handles document verification, liveness detection, face matching, OCR extraction, and automated decision-making with manual review capabilities.

## Architecture

- **NestJS Backend** (`q_nest`): Main API, file handling, database operations, decision engine
- **Python FastAPI** (`q_python`): ML/AI processing (liveness detection, face matching, OCR, document authenticity)
- **Local Storage**: File storage for development (can be upgraded to S3 later)
- **PostgreSQL**: Enhanced schema for comprehensive KYC data

## Database Schema Changes

### Enhanced Models

#### `kyc_verifications`
Added fields:
- `liveness_result` (String): Result of liveness check (live/spoof/unclear)
- `liveness_confidence` (Decimal): Confidence score for liveness detection
- `face_match_score` (Decimal): Similarity score between ID photo and selfie
- `doc_authenticity_score` (Decimal): Document authenticity verification score
- `mrz_data` (JSON): Machine Readable Zone data from passports

#### `kyc_documents`
Added fields:
- `document_type` (String): Type of document (passport/id_card/drivers_license)
- `mrz_text` (Text): Extracted MRZ text from passport
- `authenticity_flags` (JSON): Flags for various authenticity checks
- `expiration_date` (Date): Document expiration date
- `issuing_country` (String): Country that issued the document

#### `kyc_face_matches`
Added fields:
- `liveness_result` (String): Liveness result for the selfie
- `liveness_confidence` (Decimal): Confidence score for liveness
- `quality_score` (Decimal): Image quality score (lighting, occlusion, sharpness)
- `spoof_type` (String): Type of spoof detected (photo/screen/mask/deepfake)

## NestJS Backend Implementation (`q_nest`)

### New Dependencies Added

```json
{
  "@nestjs/platform-express": "^10.0.0",
  "multer": "^1.4.5-lts.1",
  "axios": "^1.6.0",
  "uuid": "^9.0.1",
  "form-data": "^4.0.0",
  "@types/express": "^4.17.21",
  "@types/multer": "^1.4.11",
  "@types/form-data": "^2.5.0",
  "@types/uuid": "^9.0.7"
}
```

### File Structure

```
q_nest/src/
├── storage/
│   ├── storage.module.ts
│   ├── storage.service.ts
│   └── interfaces/
│       └── storage.interface.ts
├── kyc/
│   ├── kyc.module.ts
│   ├── kyc.controller.ts
│   ├── dto/
│   │   ├── upload-document.dto.ts
│   │   ├── upload-selfie.dto.ts
│   │   ├── kyc-status.dto.ts
│   │   └── review-decision.dto.ts
│   ├── services/
│   │   ├── kyc.service.ts
│   │   ├── document.service.ts
│   │   ├── liveness.service.ts
│   │   ├── face-matching.service.ts
│   │   ├── decision-engine.service.ts
│   │   └── review.service.ts
│   ├── integrations/
│   │   ├── python-api.service.ts
│   │   └── interfaces/
│   │       └── python-api.interface.ts
│   └── exceptions/
│       └── kyc.exceptions.ts
├── config/
│   └── kyc.config.ts
└── common/
    └── guards/
        └── kyc-verified.guard.ts
```

### Key Components

#### 1. Storage Service (`storage/`)
- **StorageService**: Local filesystem storage with file validation
- Supports secure file naming (UUIDs)
- Interface designed for future S3 migration
- File validation (size, type, format)

#### 2. Python API Integration (`kyc/integrations/`)
- **PythonApiService**: HTTP client to call Python FastAPI endpoints
- Methods:
  - `performOCR()`: Extract text from ID documents
  - `verifyLiveness()`: Verify liveness from selfie/video
  - `matchFaces()`: Compare ID photo with selfie
  - `checkDocumentAuthenticity()`: Check document authenticity

#### 3. KYC Services (`kyc/services/`)
- **KycService**: Orchestrates the full KYC flow
- **DocumentService**: Handles ID document upload, OCR extraction, MRZ parsing, authenticity checks
- **LivenessService**: Manages selfie/video upload, liveness verification
- **FaceMatchingService**: Compares ID photo with selfie
- **DecisionEngineService**: Automated decision logic with configurable thresholds
- **ReviewService**: Manual review operations (approve/reject/resubmit)

#### 4. KYC Controller (`kyc/kyc.controller.ts`)

**Endpoints:**

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/kyc/documents` | Upload ID document | Yes |
| POST | `/kyc/selfie` | Upload selfie/video for liveness | Yes |
| POST | `/kyc/submit` | Submit complete KYC verification | Yes |
| GET | `/kyc/status` | Get current KYC status | Yes |
| GET | `/kyc/verification/:kycId` | Get verification details | Yes |
| POST | `/kyc/review/:kycId/approve` | Manual approve (admin) | Yes |
| POST | `/kyc/review/:kycId/reject` | Manual reject (admin) | Yes |
| POST | `/kyc/review/:kycId/resubmit` | Request resubmission (admin) | Yes |
| GET | `/kyc/review/pending` | List pending reviews (admin) | Yes |

#### 5. KYC Guard (`common/guards/kyc-verified.guard.ts`)
- Checks user's `kyc_status` from database
- Allows access only if status is `approved`
- Returns appropriate error messages for unverified users

#### 6. Configuration (`config/kyc.config.ts`)
- Python API base URL
- KYC thresholds:
  - Face match threshold (default: 0.8)
  - Liveness confidence threshold (default: 0.7)
  - Document authenticity threshold (default: 0.75)
- File upload limits (size, types)
- Storage paths

### Decision Engine Logic

The decision engine evaluates KYC verifications based on:

1. **Liveness Check**: Must be "live" with confidence ≥ threshold
2. **Face Match**: Similarity score must be ≥ threshold
3. **Document Authenticity**: Score must be ≥ threshold

**Decision Flow:**
- If all checks pass → `approved`
- If any check fails → `rejected` or `review` (based on confidence)
- Low confidence scores → `review` (sent for manual review)

## Python FastAPI Implementation (`q_python`)

### New Dependencies Added

```txt
python-multipart>=0.0.6
Pillow>=10.0.0
numpy>=1.24.0
opencv-python>=4.8.0
easyocr>=1.7.0
deepface>=0.0.79
mediapipe>=0.10.0
```

### Endpoints (`src/api/v1/kyc.py`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/kyc/ocr` | Extract text from ID document |
| POST | `/api/v1/kyc/liveness` | Verify liveness from selfie/video |
| POST | `/api/v1/kyc/face-match` | Compare ID photo with selfie |
| POST | `/api/v1/kyc/document-authenticity` | Check document authenticity |

### Implementation Status

**Current Status**: Placeholder implementations with TODO comments for ML model integration.

**Next Steps**:
1. Implement OCR using EasyOCR or pytesseract
2. Implement liveness detection using MediaPipe/OpenCV
3. Implement face matching using DeepFace
4. Implement document authenticity checks using computer vision

## Configuration

### Environment Variables

Add to `.env` file:

```env
# Python API
PYTHON_API_URL=http://localhost:8000

# KYC Thresholds
KYC_FACE_MATCH_THRESHOLD=0.8
KYC_LIVENESS_CONFIDENCE_THRESHOLD=0.7
KYC_DOC_AUTHENTICITY_THRESHOLD=0.75

# Storage
STORAGE_ROOT=./storage

# File Upload Limits
KYC_MAX_FILE_SIZE=10485760  # 10MB
```

## Database Migration

After schema changes, run:

```bash
cd q_nest
npm run prisma:generate
npm run prisma:migrate:dev --name add_kyc_enhancements
```

## Usage Flow

### 1. User Uploads Document
```http
POST /kyc/documents
Content-Type: multipart/form-data

file: [ID document image]
document_type: "passport"
```

### 2. User Uploads Selfie
```http
POST /kyc/selfie
Content-Type: multipart/form-data

file: [selfie image/video]
```

### 3. System Processes Verification
- Document OCR extraction
- Document authenticity check
- Liveness verification
- Face matching
- Decision engine evaluation

### 4. Check Status
```http
GET /kyc/status
```

### 5. Manual Review (Admin)
```http
POST /kyc/review/:kycId/approve
POST /kyc/review/:kycId/reject
POST /kyc/review/:kycId/resubmit
```

## Security Considerations

- ✅ File type validation
- ✅ File size limits
- ✅ Secure file naming (UUIDs)
- ✅ Files stored outside web root
- ✅ JWT authentication required
- ✅ KYC guard for protected routes
- ⚠️ Encryption at rest (optional, not implemented)
- ⚠️ Rate limiting (should be added to upload endpoints)

## Future Enhancements

- [ ] Migrate to AWS S3 for production storage
- [ ] Add webhook support for async processing
- [ ] Implement PEP/sanctions screening
- [ ] Add multi-document support (proof of address)
- [ ] Real-time status updates via WebSockets
- [ ] Background job processing for OCR/ML operations
- [ ] File encryption at rest
- [ ] Rate limiting on upload endpoints
- [ ] Admin roles and permissions for review endpoints

## Testing

### Unit Tests
- Services: DocumentService, LivenessService, FaceMatchingService
- Decision Engine: Threshold logic, decision flow
- Review Service: Approve/reject/resubmit operations

### Integration Tests
- Controller endpoints
- File upload scenarios
- Python API integration
- Database operations

## Notes

- Python endpoints currently return placeholder data
- ML models need to be implemented in Python endpoints
- Storage service designed for easy migration to S3
- Decision engine thresholds are configurable via environment variables
- Manual review endpoints require admin role (TODO: implement roles)

## Related Files

- Prisma Schema: `q_nest/prisma/schema.prisma`
- KYC Module: `q_nest/src/kyc/kyc.module.ts`
- Python KYC Router: `q_python/src/api/v1/kyc.py`
- Configuration: `q_nest/src/config/kyc.config.ts`


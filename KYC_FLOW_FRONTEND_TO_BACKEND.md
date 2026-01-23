# 🔄 Complete KYC Flow: Frontend → NestJS → Python

## Overview

Your KYC system has **3 layers**:
1. **Frontend** (QuantivaHQ-frontend) - React/Vue app
2. **NestJS Backend** (q_nest) - Main API server
3. **Python Backend** (q_python) - AI/ML service

---

## 📊 Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                   FRONTEND (React/Vue)                          │
│                                                                 │
│  User clicks "Upload Document"                                 │
│  User selects passport/ID image (file.jpg)                     │
│  File is sent as form-data to NestJS                           │
└────────────┬────────────────────────────────────────────────────┘
             │
             │ POST /kyc/documents
             │ Content-Type: multipart/form-data
             │ Body: { file: [image buffer] }
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│              NESTJS BACKEND (q_nest)                            │
│              kyc/kyc.controller.ts                              │
│                                                                 │
│  @Post('documents')                                             │
│  uploadDocument()                                               │
│  {                                                              │
│    - Receive file buffer from frontend                          │
│    - Check file is not empty                                    │
│    - Call kycService.uploadDocument()                           │
│  }                                                              │
└────────────┬────────────────────────────────────────────────────┘
             │
             │ file buffer passed
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│              NESTJS: KYC SERVICE                                │
│              kyc/services/kyc.service.ts                        │
│                                                                 │
│  uploadDocument(userId, file, documentType)                    │
│  {                                                              │
│    - Call documentService.uploadDocument()                      │
│  }                                                              │
└────────────┬────────────────────────────────────────────────────┘
             │
             │ file buffer passed
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│              NESTJS: DOCUMENT SERVICE                           │
│              kyc/services/document.service.ts                   │
│                                                                 │
│  uploadDocument(kycId, file, documentType)                     │
│  {                                                              │
│    1. Save file to local storage:                              │
│       storage/kyc/documents/[UUID].jpg                         │
│                                                                 │
│    2. Create DB record in kyc_documents table                  │
│       {                                                          │
│         kyc_id, storage_url, document_type, created_at         │
│       }                                                          │
│                                                                 │
│    3. Queue background tasks (async):                          │
│       - performOCR()      → Python /api/v1/kyc/ocr             │
│       - checkAuthenticity() → Python /api/v1/kyc/...           │
│  }                                                              │
└────────────┬────────────────────────────────────────────────────┘
             │
             │ Background OCR task starts
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│              NESTJS: PYTHON API SERVICE                         │
│              kyc/integrations/python-api.service.ts             │
│                                                                 │
│  performOCR(imageBuffer, filename)                             │
│  {                                                              │
│    - Create FormData with file                                 │
│    - POST to http://localhost:8000/api/v1/kyc/ocr              │
│    - Wait for response                                          │
│    - Update DB with OCR results                                │
│  }                                                              │
└────────────┬────────────────────────────────────────────────────┘
             │
             │ HTTP POST with image buffer
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│              PYTHON FASTAPI (q_python)                          │
│              src/api/v1/kyc.py                                  │
│                                                                 │
│  @router.post("/ocr")                                           │
│  perform_ocr(file: UploadFile)                                 │
│  {                                                              │
│    - Read file contents (bytes)                                │
│    - Convert to PIL Image                                      │
│    - Validate image format & size                              │
│    - Call extract_text() service                               │
│    - Return OCR results:                                        │
│      {                                                          │
│        "name": "John Doe",                                      │
│        "dob": "1990-01-01",                                     │
│        "id_number": "P123456",                                  │
│        "confidence": 0.92,                                      │
│        ...                                                      │
│      }                                                          │
│  }                                                              │
└────────────┬────────────────────────────────────────────────────┘
             │
             │ Response sent back to NestJS
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│  NestJS receives OCR result and saves to DB                    │
└─────────────────────────────────────────────────────────────────┘
             │
             ▼ (Frontend is ready for selfie upload)
┌─────────────────────────────────────────────────────────────────┐
│                   FRONTEND (React/Vue)                          │
│                                                                 │
│  User clicks "Upload Selfie"                                   │
│  User uploads selfie image (selfie.jpg)                        │
│  File is sent to NestJS                                        │
└────────────┬────────────────────────────────────────────────────┘
             │
             │ POST /kyc/selfie
             │ Content-Type: multipart/form-data
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│              NESTJS: KYC CONTROLLER                             │
│                                                                 │
│  @Post('selfie')                                               │
│  uploadSelfie(user, file)                                      │
│  {                                                              │
│    - Receive selfie file buffer                                │
│    - Call kycService.uploadSelfie()                            │
│  }                                                              │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│              NESTJS: KYC SERVICE                                │
│                                                                 │
│  uploadSelfie(userId, file)                                    │
│  {                                                              │
│    - Get latest verification record from DB                    │
│    - Call faceMatchingService.matchFaces()                     │
│  }                                                              │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│              NESTJS: FACE MATCHING SERVICE                      │
│              kyc/services/face-matching.service.ts              │
│                                                                 │
│  matchFaces(kycId, selfieFile)                                 │
│  {                                                              │
│    1. Get document image from storage (id_photo buffer)        │
│    2. Get selfie buffer from uploaded file                     │
│                                                                 │
│    3. CURRENTLY: AUTO-APPROVE FOR TESTING                      │
│       matchResult = { similarity: 0.95, is_match: true }       │
│       ⚠️  COMMENTED OUT: Python API call                       │
│                                                                 │
│    4. Save selfie to storage/kyc/selfies/                      │
│    5. Create kyc_face_matches DB record                        │
│    6. Auto-approve verification (test mode)                    │
│  }                                                              │
│                                                                 │
│  WHAT SHOULD HAPPEN (when enabled):                            │
│  {                                                              │
│    - Send id_photo_buffer + selfie_buffer to Python            │
│    - Call pythonApi.matchFaces()                               │
│  }                                                              │
└────────────┬────────────────────────────────────────────────────┘
             │
             │ ⚠️  CURRENTLY DISABLED - AUTO-APPROVE
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│         IF PYTHON API ENABLED: Would call Python               │
│                                                                 │
│  pythonApi.matchFaces(                                          │
│    idPhotoBuffer: Buffer,                                       │
│    selfieBuffer: Buffer,                                        │
│    idPhotoFilename: string,                                     │
│    selfieFilename: string                                       │
│  )                                                              │
│  {                                                              │
│    - Create FormData with both file buffers                    │
│    - POST to http://localhost:8000/api/v1/kyc/face-match       │
│  }                                                              │
└────────────┬────────────────────────────────────────────────────┘
             │
             │ HTTP POST with both image buffers
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│              PYTHON FASTAPI                                    │
│              src/api/v1/kyc.py                                  │
│                                                                 │
│  @router.post("/face-match")                                   │
│  match_faces_endpoint(                                          │
│    id_photo: UploadFile,                                       │
│    selfie: UploadFile                                          │
│  )                                                              │
│  {                                                              │
│    1. Read id_photo contents (bytes)                           │
│    2. Read selfie contents (bytes)                             │
│                                                                 │
│    3. Convert to PIL Images                                    │
│    4. Validate both images                                     │
│                                                                 │
│    5. Call match_faces(id_image, selfie_image)                │
│       from src/services/kyc/face_matching.py                  │
│                                                                 │
│    6. Face Matching Engine (insightface_engine.py):            │
│       {                                                          │
│         - Load face engine (Facenet512 or DeepFace)            │
│         - Detect face in ID image                              │
│         - Extract face embedding (512D vector)                 │
│         - Preprocess face (crop, resize, normalize)            │
│                                                                 │
│         - Detect face in selfie                                │
│         - Extract face embedding (512D vector)                 │
│         - Preprocess selfie face                               │
│                                                                 │
│         - Compare embeddings using multi-metric:              │
│           * Cosine similarity (70% weight)                    │
│           * Euclidean distance (20% weight)                   │
│           * Correlation coefficient (10% weight)              │
│                                                                 │
│         - Calculate combined similarity score                  │
│         - Apply threshold (0.35 for Facenet512):              │
│           * >= 0.35 = MATCH ✅                                │
│           * < 0.35 = NO MATCH ❌                              │
│       }                                                          │
│                                                                 │
│    7. Return result:                                           │
│       {                                                          │
│         "similarity": 0.68,                                     │
│         "is_match": true,                                       │
│         "decision": "accept",  // based on similarity          │
│         "confidence": 0.68,                                     │
│         "threshold": 0.35,                                      │
│         "engine": "deepface",  // or insightface               │
│         "id_face_quality": {...},                             │
│         "selfie_face_quality": {...}                          │
│       }                                                          │
│  }                                                              │
└────────────┬────────────────────────────────────────────────────┘
             │
             │ Response sent back to NestJS
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│  NestJS receives face matching result                          │
│                                                                 │
│  If is_match == true:                                           │
│    - Update kyc_verifications status = "approved"              │
│    - Save similarity score to DB                               │
│                                                                 │
│  If is_match == false:                                          │
│    - Update kyc_verifications status = "rejected"              │
│    - Save rejection reason to DB                               │
│                                                                 │
│  If 0.35 < similarity < 0.50:                                  │
│    - Update status = "review"                                  │
│    - Flag for manual review                                    │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│              FRONTEND (React/Vue)                               │
│                                                                 │
│  GET /kyc/status                                                │
│  {                                                              │
│    "status": "approved",                                        │
│    "decision_reason": "Face match successful",                 │
│    "similarity": 0.68,                                          │
│    "confidence": 0.68,                                          │
│    ...                                                          │
│  }                                                              │
│                                                                 │
│  Display result to user:                                        │
│  ✅ "KYC Approved! Your account is verified."                  │
│  or                                                             │
│  ❌ "KYC Rejected. Please resubmit clearer images."            │
│  or                                                             │
│  ⚠️  "Under Review. We will notify you soon."                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔴 CURRENT STATUS: AUTO-APPROVE MODE

Your system is currently in **TEST/AUTO-APPROVE MODE**:

### Files with AUTO-APPROVE:
1. **[face-matching.service.ts](q_nest/src/kyc/services/face-matching.service.ts#L72)**
   ```typescript
   // Line 72: Python API call is COMMENTED OUT
   // matchResult = await this.pythonApi.matchFaces(...);
   
   // Line 96: AUTO-APPROVE FOR TESTING
   matchResult = {
     similarity: 0.95,
     is_match: true,
   };
   ```

2. **[kyc.service.ts](q_nest/src/kyc/services/kyc.service.ts#L70)**
   ```typescript
   // Line 70: AUTO-APPROVE FOR TESTING
   status: 'approved',
   decision_reason: 'Auto-approved for testing (Python verification bypassed)',
   ```

### What This Means:
- ✅ **Frontend → NestJS**: Works perfectly
- ✅ **NestJS → Storage**: Images are saved to disk
- ✅ **NestJS → Database**: Records are created
- ❌ **NestJS → Python**: **COMMENTED OUT - Not being called**
- ❌ **Python Face Matching**: **Not being executed**
- ⚠️ **Result**: All verifications are auto-approved (similarity always 0.95)

---

## 🔧 How to ENABLE Python Face Matching

To enable real face matching (instead of auto-approve), you need to:

### Step 1: Enable Python API call in NestJS

**File**: [q_nest/src/kyc/services/face-matching.service.ts](q_nest/src/kyc/services/face-matching.service.ts#L47)

**Replace this:**
```typescript
// AUTO-APPROVE FOR TESTING: Set match result to approved values
matchResult = {
  similarity: 0.95,
  is_match: true,
};
```

**With this:**
```typescript
// Call Python API for actual face matching
matchResult = await this.pythonApi.matchFaces(
  idPhotoBuffer,
  selfieFile.buffer,
  document.storage_url,
  selfieFile.originalname,
);
```

### Step 2: Uncomment the try-catch block

**Replace this:**
```typescript
// COMMENTED OUT FOR TESTING: Python API call for face matching verification
// TODO: Uncomment when ready to enable Python server verification
let matchResult;
// try {
//   matchResult = await this.pythonApi.matchFaces(...);
```

**With this:**
```typescript
// Call Python API for face matching
let matchResult;
try {
  matchResult = await this.pythonApi.matchFaces(
    idPhotoBuffer,
    selfieFile.buffer,
    document.storage_url,
    selfieFile.originalname,
  );
  
  this.logger.debug(
    `Face matching result: similarity=${matchResult.similarity}, is_match=${matchResult.is_match}`,
  );
  
  if (matchResult.similarity === 0 && !matchResult.is_match) {
    this.logger.warn('Face matching returned zero similarity - faces may not have been detected');
  }
} catch (error: any) {
  this.logger.error('Face matching API call failed', {
    error: error?.message,
    stack: error?.stack,
  });
  throw new Error(
    `Face matching failed: ${error?.message || 'Unknown error'}. Please ensure both images contain clear faces.`,
  );
}
```

### Step 3: Update auto-approve in KycService

**File**: [q_nest/src/kyc/services/kyc.service.ts](q_nest/src/kyc/services/kyc.service.ts#L70)

**Replace this:**
```typescript
// AUTO-APPROVE FOR TESTING: Auto-approve the verification (bypasses decision engine)
await this.prisma.kyc_verifications.update({
  where: { kyc_id: verification.kyc_id },
  data: {
    status: 'approved',
    decision_reason: 'Auto-approved for testing (Python verification bypassed)',
    ...
  },
});
```

**With actual decision logic:**
```typescript
// Use decision engine based on face matching result
const decision = await this.decisionEngine.makeDecision(
  verification.kyc_id,
  {
    faceSimilarity: matchResult.similarity,
    isMatch: matchResult.is_match,
    ...
  }
);

await this.prisma.kyc_verifications.update({
  where: { kyc_id: verification.kyc_id },
  data: {
    status: decision.status,  // "approved", "rejected", "review"
    decision_reason: decision.reason,
    ...
  },
});
```

---

## 📊 Data Flow Summary

| Stage | Component | What Happens | Status |
|-------|-----------|--------------|--------|
| 1️⃣ Upload | Frontend → NestJS | Send image buffer | ✅ Working |
| 2️⃣ Storage | NestJS Storage | Save to disk | ✅ Working |
| 3️⃣ Database | NestJS Prisma | Record in DB | ✅ Working |
| 4️⃣ Call | NestJS → Python | Send to face engine | ❌ Disabled |
| 5️⃣ Process | Python Face Engine | DeepFace/Facenet512 | ⏸️ Not called |
| 6️⃣ Match | Python Match | Compare embeddings | ⏸️ Not called |
| 7️⃣ Response | Python → NestJS | Return similarity | ⏸️ Not called |
| 8️⃣ Decide | NestJS Decision | Approve/Reject/Review | ❌ Auto-approve |
| 9️⃣ Return | NestJS → Frontend | Send result | ✅ Working |

---

## ✅ How to Test If It's Working

### Test Current System (Auto-Approve):
```bash
# Upload document
curl -X POST http://localhost:3000/kyc/documents \
  -F "file=@passport.jpg" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Upload selfie
curl -X POST http://localhost:3000/kyc/selfie \
  -F "file=@selfie.jpg" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Check status
curl http://localhost:3000/kyc/status \
  -H "Authorization: Bearer YOUR_TOKEN"

# Response:
# { "status": "approved", "similarity": 0.95 }  ← Auto-approved
```

### Test When Python Enabled:
```bash
# Same process, but Python will:
# 1. Extract faces from both images
# 2. Compute embeddings
# 3. Compare and return real similarity score
# 4. NestJS applies decision logic
# Response will have actual similarity (e.g., 0.45, 0.72, 0.15, etc.)
```

---

## 🎯 Summary

**Your KYC flow is 90% functional:**
- ✅ Frontend uploads work
- ✅ NestJS receives and stores images
- ✅ Database integration works
- ✅ Python API is ready to receive requests
- ❌ **ONE MISSING LINK**: NestJS is not calling Python's face matching

**To make it 100% functional:**
1. Uncomment Python API call in `face-matching.service.ts`
2. Remove auto-approve logic in `kyc.service.ts`
3. Enable real decision engine based on face matching results
4. Restart NestJS backend
5. Test with actual images

**Current behavior**: All users are auto-approved with 95% similarity
**After fix**: Real face matching with actual similarity scores

Let me know if you need help enabling the Python API calls!

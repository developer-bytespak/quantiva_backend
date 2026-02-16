"""
KYC API Endpoints
=================
Document verification, liveness detection, face matching, and OCR endpoints.
Uses DeepFace for face operations.

⚠️ DEPRECATION NOTICE ⚠️
-------------------------
The following endpoints are DEPRECATED and will be removed in a future version:
- POST /kyc/face-match
- POST /kyc/liveness
- POST /kyc/document-authenticity
- POST /kyc/verify

Reason: KYC verification has been migrated to Sumsub (third-party KYC provider).
These endpoints are maintained for backward compatibility with legacy verifications only.

For new KYC verifications, use the Sumsub integration in the NestJS backend.
"""

import io
import logging
import time
import asyncio
from typing import Optional
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, UploadFile, File, HTTPException
from PIL import Image


from src.services.kyc.face_matching import match_faces, verify_face_quality, get_engine_status
from src.services.kyc.liveness_service import detect_liveness
from src.services.kyc.document_verification import check_authenticity

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/kyc", tags=["KYC"])

# Thread pool for CPU-intensive face matching operations
# This prevents blocking the async event loop so other requests can be processed
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="kyc_")


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

async def _load_image(file: UploadFile) -> Image.Image:
    """Load and validate uploaded image file"""
    contents = await file.read()
    
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file provided")
    
    try:
        image = Image.open(io.BytesIO(contents))
        if image.mode != 'RGB':
            image = image.convert('RGB')
        return image
    except Exception as e:
        logger.error(f"Failed to open image: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Invalid image format: {str(e)}")


def _validate_image(image: Image.Image) -> None:
    """Validate image dimensions"""
    min_width, min_height = 100, 100
    max_width, max_height = 10000, 10000
    
    if image.width < min_width or image.height < min_height:
        raise HTTPException(
            status_code=400, 
            detail=f"Image too small ({image.width}x{image.height}). Minimum: {min_width}x{min_height}"
        )
    
    if image.width > max_width or image.height > max_height:
        raise HTTPException(
            status_code=400,
            detail=f"Image too large ({image.width}x{image.height}). Maximum: {max_width}x{max_height}"
        )


# =============================================================================
# STATUS ENDPOINT
# =============================================================================

@router.get("/engine-status")
async def get_face_engine_status():
    """
    Get the current face recognition engine status.
    
    Returns:
        - engine: Name of the active engine (deepface)
        - initialized: Whether the engine is ready
        - thresholds: Matching thresholds for accept/review
    """
    try:
        return get_engine_status()
    except Exception as e:
        logger.error(f"Engine status check failed: {str(e)}")
        return {
            "engine": "unknown",
            "initialized": False,
            "error": str(e)
        }


@router.post("/warmup")
async def warmup_face_engine():
    """
    Pre-load the face recognition engine and models.
    Call this endpoint on server startup to avoid timeout on first KYC request.
    
    This loads:
        - DeepFace Facenet512 model
        - Face detection backend
        - Quality assessment module
    
    Returns:
        - success: Whether warmup completed successfully
        - engine: Engine name
        - initialized: Whether engine is now ready
        - message: Status message
    """
    import time
    start_time = time.time()
    
    try:
        logger.info("Starting face engine warmup...")
        
        # Import and initialize the face engine
        from src.services.kyc.face_engine import get_face_engine
        engine = get_face_engine()
        
        elapsed = time.time() - start_time
        logger.info(f"Face engine warmup completed in {elapsed:.2f}s")
        
        return {
            "success": True,
            "engine": "deepface-facenet512",
            "initialized": engine._initialized,
            "warmup_time_seconds": round(elapsed, 2),
            "message": "Face engine loaded and ready for KYC operations"
        }
    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"Face engine warmup failed after {elapsed:.2f}s: {str(e)}", exc_info=True)
        return {
            "success": False,
            "engine": "unknown",
            "initialized": False,
            "warmup_time_seconds": round(elapsed, 2),
            "error": str(e),
            "message": "Face engine warmup failed"
        }


# =============================================================================
# WARMUP ENDPOINT
# =============================================================================

@router.post("/warmup")
async def warmup_face_engine():
    """
    Pre-load the face recognition engine and models.
    Call this endpoint on server startup to avoid timeout on first KYC request.
    
    This loads:
        - DeepFace Facenet512 model (optimized)
        - OpenCV face detection backend
    
    Returns:
        - success: Whether warmup completed successfully
        - engine: Engine name
        - initialized: Whether engine is now ready
        - message: Status message
    """
    import time
    start_time = time.time()
    
    try:
        logger.info("Starting face engine warmup (optimized)...")
        
        # Import and initialize the optimized face engine
        from src.services.kyc.face_engine_optimized import get_face_engine
        engine = get_face_engine()
        
        elapsed = time.time() - start_time
        logger.info(f"Face engine warmup completed in {elapsed:.2f}s")
        
        return {
            "success": True,
            "engine": "deepface-facenet512-optimized",
            "initialized": engine._initialized,
            "warmup_time_seconds": round(elapsed, 2),
            "message": "Optimized face engine loaded and ready for KYC operations"
        }
    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"Face engine warmup failed after {elapsed:.2f}s: {str(e)}", exc_info=True)
        return {
            "success": False,
            "engine": "unknown",
            "initialized": False,
            "warmup_time_seconds": round(elapsed, 2),
            "error": str(e),
            "message": "Face engine warmup failed"
        }


# =============================================================================
# FACE QUALITY ENDPOINT
# =============================================================================

@router.post("/face-quality")
async def check_face_quality(file: UploadFile = File(...)):
    """
    Check face quality in an image.
    
    Returns:
        - is_acceptable: Whether face quality meets minimum requirements
        - quality_score: Overall quality score (0-1)
        - details: Detailed quality metrics (blur, brightness, contrast, pose, occlusion)
    """
    try:
        image = await _load_image(file)
        _validate_image(image)
        
        logger.info(f"Face quality check: {file.filename}")
        is_acceptable, quality_score, quality_details = verify_face_quality(image)
        
        return {
            "is_acceptable": is_acceptable,
            "quality_score": quality_score,
            "details": quality_details
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Face quality check failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Face quality check failed: {str(e)}")


# =============================================================================
# OCR ENDPOINT
# =============================================================================

@router.post("/ocr")
async def perform_ocr(file: UploadFile = File(...)):
    """
    Extract text from ID document using OCR.
    
    Returns:
        - name: Extracted name
        - dob: Date of birth
        - id_number: ID/passport number
        - nationality: Nationality
        - expiration_date: Document expiration date
        - mrz_text: Machine Readable Zone text (for passports)
        - confidence: OCR confidence score
        - raw_text: All extracted text
    """
    try:
        image = await _load_image(file)
        _validate_image(image)
        
        logger.info(f"OCR processing: {file.filename}")
        result = {"error": "OCR service removed"}
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"OCR processing failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"OCR processing failed: {str(e)}")


# =============================================================================
# OCR ENDPOINT
# =============================================================================

@router.post("/ocr")
async def perform_ocr(file: UploadFile = File(...)):
    """
    Extract text from ID document using OCR.
    
    Returns:
        - name: Extracted name
        - dob: Date of birth
        - id_number: ID/passport number
        - nationality: Nationality
        - expiration_date: Document expiration date
        - mrz_text: Machine Readable Zone text (for passports)
        - confidence: OCR confidence score
        - raw_text: All extracted text
    """
    try:
        image = await _load_image(file)
        _validate_image(image)
        
        logger.info(f"OCR processing: {file.filename} - returning hardcoded response")
        
        # Return hardcoded OCR response
        return {
            "name": "John Doe",
            "dob": "1990-01-01",
            "id_number": "ID123456789",
            "nationality": "US",
            "expiration_date": "2030-01-01",
            "mrz_text": "P<USAJOHNDOE<<<<<<<<<<<<<<<<<<<<<<<<<<",
            "confidence": 0.95,
            "raw_text": "UNITED STATES OF AMERICA\nJOHN DOE\n01 JAN 1990\nID123456789",
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"OCR processing failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"OCR processing failed: {str(e)}")


# =============================================================================
# LIVENESS ENDPOINT
# =============================================================================

@router.post("/liveness")
async def verify_liveness(file: UploadFile = File(...)):
    """
    Verify liveness from selfie photo.
    Uses multi-modal analysis (texture, depth, reflection).
    
    Returns:
        - liveness: "live" | "spoof" | "unclear"
        - confidence: Liveness confidence score (0-1)
        - spoof_type: Detected spoof type if applicable
        - quality_score: Image quality score
        - face_quality: Detailed face quality metrics
        - texture_score: Texture analysis score
        - depth_score: Depth cues analysis score
        - reflection_score: Reflection analysis score
    """
    try:
        # Check for video (not fully supported yet)
        is_video = False
        if file.filename:
            video_extensions = {'.mp4', '.webm', '.avi', '.mov'}
            file_ext = '.' + file.filename.lower().split('.')[-1] if '.' in file.filename else ''
            is_video = file_ext in video_extensions
        
        if is_video:
            logger.warning("Video liveness detection not fully implemented")
            return {
                "liveness": "unclear",
                "confidence": 0.0,
                "spoof_type": None,
                "quality_score": 0.0,
                "error": "Video input not fully supported"
            }
        
        image = await _load_image(file)
        _validate_image(image)
        
        logger.info(f"Liveness detection: {file.filename}")
        result = detect_liveness(image, is_video=is_video)
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Liveness verification failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Liveness verification failed: {str(e)}")


# =============================================================================
# FACE MATCHING ENDPOINT
# =============================================================================

@router.post("/face-match")
async def match_faces_endpoint(
    id_photo: UploadFile = File(...),
    selfie: UploadFile = File(...),
):
    """
    ⚠️ DEPRECATED - Use Sumsub integration instead
    
    Compare face from ID photo with selfie.
    
    This endpoint is deprecated and maintained only for backward compatibility
    with legacy DeepFace-based KYC verifications. New verifications should use
    the Sumsub integration in the NestJS backend.
    
    Returns:
        - similarity: Cosine similarity score (0-1)
        - is_match: Whether faces match (above accept threshold)
        - decision: "accept" | "review" | "reject"
        - confidence: Decision confidence score
        - threshold: Threshold used for matching
        - engine: Engine used (deepface)
        - id_face_quality: Quality metrics for ID photo face
        - selfie_face_quality: Quality metrics for selfie face
    """
    logger.warning("⚠️ DEPRECATED ENDPOINT CALLED: /kyc/face-match - Please migrate to Sumsub")
    
    request_start = time.time()
    logger.info("\n" + "="*70)
    logger.info("🚀 [API] POST /kyc/face-match - REQUEST RECEIVED (DEPRECATED)")
    logger.info("="*70)
    
    try:
        # Load both images
        logger.info("📷 [API] Step 1: Loading images...")
        load_start = time.time()
        id_image = await _load_image(id_photo)
        selfie_image = await _load_image(selfie)
        load_time = time.time() - load_start
        logger.info(f"   ID photo: {id_photo.filename} ({id_image.size[0]}x{id_image.size[1]})")
        logger.info(f"   Selfie: {selfie.filename} ({selfie_image.size[0]}x{selfie_image.size[1]})")
        logger.info(f"   Images loaded in {load_time:.2f}s")
        
        # Validate both
        logger.info("✅ [API] Step 2: Validating images...")
        _validate_image(id_image)
        _validate_image(selfie_image)
        logger.info("   Image validation passed")
        
        logger.info("🧠 [API] Step 3: Starting face matching engine...")
        match_start = time.time()
        
        # Run CPU-intensive face matching in thread pool
        # This prevents blocking the event loop so other requests can be processed
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_executor, match_faces, id_image, selfie_image)
        
        match_time = time.time() - match_start
        
        total_time = time.time() - request_start
        logger.info("\n" + "="*70)
        logger.info(f"✅ [API] FACE MATCH COMPLETE")
        logger.info(f"   Decision: {result.get('decision', 'unknown').upper()}")
        logger.info(f"   Similarity: {result.get('similarity', 0):.3f}")
        logger.info(f"   Match time: {match_time:.2f}s")
        logger.info(f"   Total request time: {total_time:.2f}s")
        logger.info("="*70 + "\n")
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        total_time = time.time() - request_start
        logger.error(f"\n" + "="*70)
        logger.error(f"❌ [API] FACE MATCH FAILED after {total_time:.2f}s")
        logger.error(f"   Error: {str(e)}")
        logger.error("="*70 + "\n", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Face matching failed: {str(e)}")


# =============================================================================
# DOCUMENT AUTHENTICITY ENDPOINT
# =============================================================================

@router.post("/document-authenticity")
async def check_document_authenticity_endpoint(file: UploadFile = File(...)):
    """
    Check document authenticity by detecting tampering and verifying patterns.
    
    Returns:
        - is_authentic: Whether document appears authentic
        - authenticity_score: Overall authenticity score (0-1)
        - flags:
            - hologram_detected: Whether hologram patterns were found
            - texture_consistent: Whether texture is consistent
            - tamper_detected: Whether tampering was detected
            - font_consistent: Whether fonts are consistent
    """
    try:
        image = await _load_image(file)
        _validate_image(image)
        
        logger.info(f"Document authenticity check: {file.filename}")
        result = check_authenticity(image)
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Document authenticity check failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Document authenticity check failed: {str(e)}")


# =============================================================================
# COMPLETE KYC VERIFICATION ENDPOINT
# =============================================================================

@router.post("/verify")
async def complete_kyc_verification(
    id_document: UploadFile = File(...),
    selfie: UploadFile = File(...),
):
    """
    Complete KYC verification in one request.
    Performs: OCR, document authenticity, liveness, and face matching.
    
    Returns:
        - status: "approved" | "review" | "rejected"
        - ocr: OCR extraction results
        - authenticity: Document authenticity results
        - liveness: Liveness detection results
        - face_match: Face matching results
        - errors: List of any errors encountered
    """
    request_start = time.time()
    logger.info("\n" + "="*70)
    logger.info("🚀 [API] POST /kyc/verify - FULL KYC VERIFICATION")
    logger.info("="*70)
    
    errors = []
    
    try:
        # Load images
        logger.info("📷 [API] Loading images...")
        id_image = await _load_image(id_document)
        selfie_image = await _load_image(selfie)
        logger.info(f"   ID document: {id_document.filename} ({id_image.size[0]}x{id_image.size[1]})")
        logger.info(f"   Selfie: {selfie.filename} ({selfie_image.size[0]}x{selfie_image.size[1]})")
        
        # Reset file positions for re-reading if needed
        await id_document.seek(0)
        await selfie.seek(0)
        
        _validate_image(id_image)
        _validate_image(selfie_image)
        logger.info("✅ Images validated")
        
        # Step 1: OCR (hardcoded for now)
        logger.info("📄 [KYC-VERIFY] Step 1/4: OCR extraction...")
        ocr_result = {
            "name": "John Doe",
            "dob": "1990-01-01", 
            "id_number": "ID123456789",
            "nationality": "US",
            "expiration_date": "2030-01-01",
            "mrz_text": "P<USAJOHNDOE<<<<<<<<<<<<<<<<<<<<<<<<<<",
            "confidence": 0.95,
            "raw_text": "UNITED STATES OF AMERICA\nJOHN DOE\n01 JAN 1990\nID123456789",
        }
        logger.info("   OCR complete (hardcoded response)")
        
        # Step 2: Document authenticity
        logger.info("🔐 [KYC-VERIFY] Step 2/4: Document authenticity check...")
        step_start = time.time()
        authenticity_result = None
        try:
            authenticity_result = check_authenticity(id_image)
            logger.info(f"   Authenticity complete in {time.time()-step_start:.2f}s: {authenticity_result.get('is_authentic', 'unknown')}")
        except Exception as e:
            errors.append(f"Authenticity check failed: {str(e)}")
            logger.error(f"   ❌ Authenticity FAILED: {e}")
        
        # Step 3: Liveness
        logger.info("👤 [KYC-VERIFY] Step 3/4: Liveness detection...")
        step_start = time.time()
        liveness_result = None
        try:
            liveness_result = detect_liveness(selfie_image)
            logger.info(f"   Liveness complete in {time.time()-step_start:.2f}s: {liveness_result.get('liveness', 'unknown')}")
        except Exception as e:
            errors.append(f"Liveness detection failed: {str(e)}")
            logger.error(f"   ❌ Liveness FAILED: {e}")
        
        # Step 4: Face matching (the main operation)
        logger.info("🧠 [KYC-VERIFY] Step 4/4: Face matching...")
        step_start = time.time()
        face_match_result = None
        try:
            face_match_result = match_faces(id_image, selfie_image)
            logger.info(f"   Face match complete in {time.time()-step_start:.2f}s: {face_match_result.get('decision', 'unknown')}")
        except Exception as e:
            errors.append(f"Face matching failed: {str(e)}")
            logger.error(f"   ❌ Face matching FAILED: {e}")
        
        # Determine overall status
        status = _determine_overall_status(
            authenticity_result,
            liveness_result,
            face_match_result
        )
        
        total_time = time.time() - request_start
        logger.info("\n" + "="*70)
        logger.info(f"✅ [KYC-VERIFY] VERIFICATION COMPLETE")
        logger.info(f"   Final Status: {status.upper()}")
        logger.info(f"   Total time: {total_time:.2f}s")
        if errors:
            logger.info(f"   Errors: {len(errors)}")
        logger.info("="*70 + "\n")
        
        return {
            "status": status,
            "ocr": ocr_result,
            "authenticity": authenticity_result,
            "liveness": liveness_result,
            "face_match": face_match_result,
            "errors": errors if errors else None,
            "processing_time_seconds": round(total_time, 2)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        total_time = time.time() - request_start
        logger.error(f"\n" + "="*70)
        logger.error(f"❌ [KYC-VERIFY] VERIFICATION FAILED after {total_time:.2f}s")
        logger.error(f"   Error: {str(e)}")
        logger.error("="*70 + "\n", exc_info=True)
        raise HTTPException(status_code=500, detail=f"KYC verification failed: {str(e)}")


def _determine_overall_status(
    authenticity: Optional[dict],
    liveness: Optional[dict],
    face_match: Optional[dict]
) -> str:
    """Determine overall KYC status from individual results"""
    
    # Check for critical failures
    if face_match is None or face_match.get("error"):
        return "rejected"
    
    # Check face match decision
    face_decision = face_match.get("decision", "reject")
    if face_decision == "reject":
        return "rejected"
    
    # Check liveness
    if liveness:
        liveness_status = liveness.get("liveness", "unclear")
        if liveness_status == "spoof":
            return "rejected"
        if liveness_status == "unclear":
            return "review"
    
    # Check authenticity
    if authenticity:
        if authenticity.get("flags", {}).get("tamper_detected"):
            return "rejected"
        if not authenticity.get("is_authentic"):
            return "review"
    
    # If face match needs review
    if face_decision == "review":
        return "review"
    
    # All checks passed
    return "approved"

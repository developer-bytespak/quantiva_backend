"""
KYC API Endpoints
=================
Document verification, liveness detection, face matching, and OCR endpoints.
Uses InsightFace engine for face operations with DeepFace fallback.
"""

import io
import logging
from typing import Optional

from fastapi import APIRouter, UploadFile, File, HTTPException
from PIL import Image

from src.services.kyc.ocr_service import extract_text
from src.services.kyc.face_matching import match_faces, verify_face_quality, get_engine_status
from src.services.kyc.liveness_service import detect_liveness
from src.services.kyc.document_verification import check_authenticity

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/kyc", tags=["KYC"])


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
        - engine: Name of the active engine (insightface/deepface)
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
        result = extract_text(image)
        
        return result
        
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
    Compare face from ID photo with selfie.
    
    Returns:
        - similarity: Cosine similarity score (0-1)
        - is_match: Whether faces match (above accept threshold)
        - decision: "accept" | "review" | "reject"
        - confidence: Decision confidence score
        - threshold: Threshold used for matching
        - engine: Engine used (insightface/deepface)
        - id_face_quality: Quality metrics for ID photo face
        - selfie_face_quality: Quality metrics for selfie face
    """
    try:
        # Load both images
        id_image = await _load_image(id_photo)
        selfie_image = await _load_image(selfie)
        
        # Validate both
        _validate_image(id_image)
        _validate_image(selfie_image)
        
        logger.info(f"Face matching: ID={id_photo.filename}, selfie={selfie.filename}")
        result = match_faces(id_image, selfie_image)
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Face matching failed: {str(e)}", exc_info=True)
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
    errors = []
    
    try:
        # Load images
        id_image = await _load_image(id_document)
        selfie_image = await _load_image(selfie)
        
        # Reset file positions for re-reading if needed
        await id_document.seek(0)
        await selfie.seek(0)
        
        _validate_image(id_image)
        _validate_image(selfie_image)
        
        # 1. OCR
        ocr_result = None
        try:
            ocr_result = extract_text(id_image)
        except Exception as e:
            errors.append(f"OCR failed: {str(e)}")
            logger.error(f"OCR in complete verification failed: {e}")
        
        # 2. Document authenticity
        authenticity_result = None
        try:
            authenticity_result = check_authenticity(id_image)
        except Exception as e:
            errors.append(f"Authenticity check failed: {str(e)}")
            logger.error(f"Authenticity in complete verification failed: {e}")
        
        # 3. Liveness
        liveness_result = None
        try:
            liveness_result = detect_liveness(selfie_image)
        except Exception as e:
            errors.append(f"Liveness detection failed: {str(e)}")
            logger.error(f"Liveness in complete verification failed: {e}")
        
        # 4. Face matching
        face_match_result = None
        try:
            face_match_result = match_faces(id_image, selfie_image)
        except Exception as e:
            errors.append(f"Face matching failed: {str(e)}")
            logger.error(f"Face matching in complete verification failed: {e}")
        
        # Determine overall status
        status = _determine_overall_status(
            authenticity_result,
            liveness_result,
            face_match_result
        )
        
        return {
            "status": status,
            "ocr": ocr_result,
            "authenticity": authenticity_result,
            "liveness": liveness_result,
            "face_match": face_match_result,
            "errors": errors if errors else None
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Complete KYC verification failed: {str(e)}", exc_info=True)
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

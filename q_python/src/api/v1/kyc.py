"""
KYC API endpoints for document verification, liveness detection, face matching, and OCR.
"""
from fastapi import APIRouter, UploadFile, File, HTTPException
from typing import Optional
import io
from PIL import Image
import logging

from src.services.kyc.ocr_service import extract_text
from src.services.kyc.face_matching import match_faces
from src.services.kyc.liveness_service import detect_liveness
from src.services.kyc.document_verification import check_authenticity
from src.utils.image_utils import validate_image, bytes_to_image

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/kyc", tags=["KYC"])


@router.post("/ocr")
async def perform_ocr(file: UploadFile = File(...)):
    """
    Extract text from ID document using OCR.
    Returns name, DOB, ID number, nationality, expiration date, and MRZ text.
    """
    try:
        # Read file content
        contents = await file.read()
        
        if not contents:
            raise HTTPException(status_code=400, detail="Empty file provided")
        
        # Convert to PIL Image
        try:
            image = Image.open(io.BytesIO(contents))
            # Convert to RGB if necessary
            if image.mode != 'RGB':
                image = image.convert('RGB')
        except Exception as e:
            logger.error(f"Failed to open image: {str(e)}")
            raise HTTPException(status_code=400, detail=f"Invalid image format: {str(e)}")
        
        # Validate image
        is_valid, error_msg = validate_image(image)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error_msg or "Invalid image")
        
        # Extract text using OCR service
        logger.info(f"Processing OCR for file: {file.filename}")
        result = extract_text(image)
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"OCR processing failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"OCR processing failed: {str(e)}")


@router.post("/liveness")
async def verify_liveness(file: UploadFile = File(...)):
    """
    Verify liveness from selfie photo or video.
    Returns liveness status (live/spoof/unclear), confidence score, and spoof type if detected.
    """
    try:
        # Read file content
        contents = await file.read()
        
        if not contents:
            raise HTTPException(status_code=400, detail="Empty file provided")
        
        # Check if it's a video (simplified check by extension)
        is_video = False
        if file.filename:
            video_extensions = {'.mp4', '.webm', '.avi', '.mov'}
            file_ext = file.filename.lower().split('.')[-1]
            is_video = f'.{file_ext}' in video_extensions
        
        # For now, handle images only (video support can be added later)
        if is_video:
            logger.warning("Video liveness detection not yet fully implemented")
            # For videos, we'd extract frames and process them
            # For now, return unclear status
            return {
                "liveness": "unclear",
                "confidence": 0.0,
                "spoof_type": None,
                "quality_score": 0.0,
            }
        
        # Convert to PIL Image
        try:
            image = Image.open(io.BytesIO(contents))
            # Convert to RGB if necessary
            if image.mode != 'RGB':
                image = image.convert('RGB')
        except Exception as e:
            logger.error(f"Failed to open image: {str(e)}")
            raise HTTPException(status_code=400, detail=f"Invalid image format: {str(e)}")
        
        # Validate image
        is_valid, error_msg = validate_image(image)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error_msg or "Invalid image")
        
        # Detect liveness using service
        logger.info(f"Processing liveness detection for file: {file.filename}")
        result = detect_liveness(image, is_video=is_video)
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Liveness verification failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Liveness verification failed: {str(e)}")


@router.post("/face-match")
async def match_faces_endpoint(
    id_photo: UploadFile = File(...),
    selfie: UploadFile = File(...),
):
    """
    Compare face from ID photo with selfie.
    Returns similarity score and match result.
    """
    try:
        # Read both files
        id_photo_contents = await id_photo.read()
        selfie_contents = await selfie.read()
        
        if not id_photo_contents:
            raise HTTPException(status_code=400, detail="Empty ID photo provided")
        if not selfie_contents:
            raise HTTPException(status_code=400, detail="Empty selfie provided")
        
        # Convert to PIL Images
        try:
            id_image = Image.open(io.BytesIO(id_photo_contents))
            if id_image.mode != 'RGB':
                id_image = id_image.convert('RGB')
        except Exception as e:
            logger.error(f"Failed to open ID photo: {str(e)}")
            raise HTTPException(status_code=400, detail=f"Invalid ID photo format: {str(e)}")
        
        try:
            selfie_image = Image.open(io.BytesIO(selfie_contents))
            if selfie_image.mode != 'RGB':
                selfie_image = selfie_image.convert('RGB')
        except Exception as e:
            logger.error(f"Failed to open selfie: {str(e)}")
            raise HTTPException(status_code=400, detail=f"Invalid selfie format: {str(e)}")
        
        # Validate images
        is_valid, error_msg = validate_image(id_image)
        if not is_valid:
            raise HTTPException(status_code=400, detail=f"Invalid ID photo: {error_msg}")
        
        is_valid, error_msg = validate_image(selfie_image)
        if not is_valid:
            raise HTTPException(status_code=400, detail=f"Invalid selfie: {error_msg}")
        
        # Match faces using service
        logger.info(f"Processing face matching: ID photo={id_photo.filename}, selfie={selfie.filename}")
        result = match_faces(id_image, selfie_image)
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Face matching failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Face matching failed: {str(e)}")


@router.post("/document-authenticity")
async def check_document_authenticity_endpoint(file: UploadFile = File(...)):
    """
    Check document authenticity by detecting tampering, holograms, texture consistency, etc.
    Returns authenticity status, score, and flags for various checks.
    """
    try:
        # Read file content
        contents = await file.read()
        
        if not contents:
            raise HTTPException(status_code=400, detail="Empty file provided")
        
        # Convert to PIL Image
        try:
            image = Image.open(io.BytesIO(contents))
            # Convert to RGB if necessary
            if image.mode != 'RGB':
                image = image.convert('RGB')
        except Exception as e:
            logger.error(f"Failed to open image: {str(e)}")
            raise HTTPException(status_code=400, detail=f"Invalid image format: {str(e)}")
        
        # Validate image
        is_valid, error_msg = validate_image(image)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error_msg or "Invalid image")
        
        # Check authenticity using service
        logger.info(f"Processing document authenticity check for file: {file.filename}")
        result = check_authenticity(image)
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Document authenticity check failed: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500, detail=f"Document authenticity check failed: {str(e)}"
        )

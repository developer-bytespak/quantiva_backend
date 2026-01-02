"""
KYC API endpoints for document verification, liveness detection, face matching, and OCR.
"""
from fastapi import APIRouter, UploadFile, File, HTTPException
from typing import Optional
import io
import time
import threading
import gc
import psutil
import os
from PIL import Image
import logging

from src.services.kyc.ocr_service import extract_text
from src.services.kyc.face_matching import match_faces
from src.services.kyc.liveness_service import detect_liveness
from src.services.kyc.document_verification import check_authenticity
from src.utils.image_utils import validate_image, bytes_to_image, resize_image_if_needed

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/kyc", tags=["KYC"])


def log_memory_usage(operation_name: str):
    """Log current memory usage for debugging"""
    try:
        process = psutil.Process(os.getpid())
        memory_info = process.memory_info()
        memory_mb = memory_info.rss / 1024 / 1024
        print(f"[MEMORY_USAGE] {operation_name}: {memory_mb:.2f} MB")
        
        # Force garbage collection if memory usage is high
        if memory_mb > 1000:  # If using more than 1GB
            print(f"[MEMORY_CLEANUP] High memory usage detected, forcing garbage collection...")
            gc.collect()
    except Exception as e:
        print(f"[MEMORY_USAGE_ERROR] Failed to log memory usage: {e}")


def safe_image_processing(func, *args, **kwargs):
    """Safely execute image processing functions with error handling"""
    try:
        log_memory_usage(f"Before {func.__name__}")
        result = func(*args, **kwargs)
        log_memory_usage(f"After {func.__name__}")
        return result, None
    except MemoryError as e:
        error_msg = f"Memory error in {func.__name__}: {str(e)}"
        print(f"[MEMORY_ERROR] {error_msg}")
        gc.collect()  # Force cleanup
        return None, error_msg
    except Exception as e:
        error_msg = f"Error in {func.__name__}: {str(e)}"
        print(f"[PROCESSING_ERROR] {error_msg}")
        return None, error_msg


def run_with_timeout(func, timeout_seconds=120):
    """
    Run a function with a timeout and return result or timeout error.
    """
    result = {'value': None, 'error': None}
    
    def target():
        try:
            result['value'] = func()
        except Exception as e:
            result['error'] = e
    
    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    thread.join(timeout=timeout_seconds)
    
    if thread.is_alive():
        return None, f"Operation timed out after {timeout_seconds} seconds"
    
    if result['error']:
        raise result['error']
    
    return result['value'], None


@router.post("/ocr")
async def perform_ocr(file: UploadFile = File(...)):
    """
    Extract text from ID document using OCR.
    Returns name, DOB, ID number, nationality, expiration date, and MRZ text.
    """
    request_start = time.time()
    print("=== PYTHON OCR PROCESSING STARTED ===")
    print(f"[PYTHON_OCR_START] Received document image: {file.filename}")
    print(f"[PYTHON_OCR_START] Content type: {file.content_type}")
    print(f"[PYTHON_OCR_START] Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    
    try:
        # Read file content
        print("[PYTHON_OCR_STEP_1] Reading file content...")
        contents = await file.read()
        file_size = len(contents) if contents else 0
        print(f"[PYTHON_OCR_STEP_1] File content read: {file_size} bytes")
        
        if not contents:
            print("[PYTHON_OCR_ERROR] Empty file provided")
            raise HTTPException(status_code=400, detail="Empty file provided")
        
        # Convert to PIL Image
        print("[PYTHON_OCR_STEP_2] Converting to PIL Image...")
        try:
            image = Image.open(io.BytesIO(contents))
            print(f"[PYTHON_OCR_STEP_2] Image opened: {image.size} pixels, mode: {image.mode}")
            # Convert to RGB if necessary
            if image.mode != 'RGB':
                print(f"[PYTHON_OCR_STEP_2] Converting from {image.mode} to RGB mode")
                image = image.convert('RGB')
        except Exception as e:
            print(f"[PYTHON_OCR_ERROR] Failed to open image: {str(e)}")
            logger.error(f"Failed to open image: {str(e)}")
            raise HTTPException(status_code=400, detail=f"Invalid image format: {str(e)}")
        
        # Validate image
        print("[PYTHON_OCR_STEP_3] Validating image...")
        is_valid, error_msg = validate_image(image)
        if not is_valid:
            print(f"[PYTHON_OCR_ERROR] Image validation failed: {error_msg}")
            raise HTTPException(status_code=400, detail=error_msg or "Invalid image")
        print("[PYTHON_OCR_STEP_3] Image validation passed")
        
        # Extract text using OCR service
        print(f"[PYTHON_OCR_STEP_4] Starting OCR text extraction for file: {file.filename}")
        logger.info(f"Processing OCR for file: {file.filename}")
        ocr_start = time.time()
        result = extract_text(image)
        ocr_time = time.time() - ocr_start
        
        print(f"[PYTHON_OCR_STEP_4] OCR extraction completed in {ocr_time:.2f}s")
        print(f"[PYTHON_OCR_RESULT] Extracted data:")
        print(f"  - Name: {result.get('name', 'Not found')}")
        print(f"  - DOB: {result.get('dob', 'Not found')}")
        print(f"  - ID Number: {result.get('id_number', 'Not found')}")
        print(f"  - Nationality: {result.get('nationality', 'Not found')}")
        print(f"  - Expiration: {result.get('expiration_date', 'Not found')}")
        print(f"  - Confidence: {result.get('confidence', 0.0):.3f}")
        print(f"  - MRZ Text: {'Found' if result.get('mrz_text') else 'Not found'}")
        
        total_time = time.time() - request_start
        print(f"[PYTHON_OCR_SUCCESS] Total processing time: {total_time:.2f}s")
        print("=== PYTHON OCR PROCESSING COMPLETED ===\\n")
        
        return result
        
    except HTTPException:
        total_time = time.time() - request_start
        print(f"[PYTHON_OCR_ERROR] HTTPException after {total_time:.2f}s")
        print("=== PYTHON OCR PROCESSING FAILED ===\\n")
        raise
    except Exception as e:
        total_time = time.time() - request_start
        print(f"[PYTHON_OCR_ERROR] Unexpected error after {total_time:.2f}s: {str(e)}")
        print("=== PYTHON OCR PROCESSING FAILED ===\\n")
        logger.error(f"OCR processing failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"OCR processing failed: {str(e)}")


@router.post("/liveness")
async def verify_liveness(file: UploadFile = File(...)):
    """
    Verify liveness from selfie photo or video.
    Returns liveness status (live/spoof/unclear), confidence score, and spoof type if detected.
    """
    request_start = time.time()
    print("=== PYTHON LIVENESS DETECTION STARTED ===")
    print(f"[PYTHON_LIVENESS_START] Received selfie: {file.filename}")
    print(f"[PYTHON_LIVENESS_START] Content type: {file.content_type}")
    print(f"[PYTHON_LIVENESS_START] Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    
    try:
        # Read file content
        print("[PYTHON_LIVENESS_STEP_1] Reading file content...")
        contents = await file.read()
        file_size = len(contents) if contents else 0
        print(f"[PYTHON_LIVENESS_STEP_1] File content read: {file_size} bytes")
        
        if not contents:
            print("[PYTHON_LIVENESS_ERROR] Empty file provided")
            raise HTTPException(status_code=400, detail="Empty file provided")
        
        # Check if it's a video (simplified check by extension)
        is_video = False
        if file.filename:
            video_extensions = {'.mp4', '.webm', '.avi', '.mov'}
            file_ext = file.filename.lower().split('.')[-1]
            is_video = f'.{file_ext}' in video_extensions
            print(f"[PYTHON_LIVENESS_STEP_2] File type detection: {'video' if is_video else 'image'}")
        
        # For now, handle images only (video support can be added later)
        if is_video:
            print("[PYTHON_LIVENESS_WARNING] Video liveness detection not yet fully implemented")
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
        print("[PYTHON_LIVENESS_STEP_3] Converting to PIL Image...")
        try:
            image = Image.open(io.BytesIO(contents))
            print(f"[PYTHON_LIVENESS_STEP_3] Image opened: {image.size} pixels, mode: {image.mode}")
            # Convert to RGB if necessary
            if image.mode != 'RGB':
                print(f"[PYTHON_LIVENESS_STEP_3] Converting from {image.mode} to RGB mode")
                image = image.convert('RGB')
        except Exception as e:
            print(f"[PYTHON_LIVENESS_ERROR] Failed to open image: {str(e)}")
            logger.error(f"Failed to open image: {str(e)}")
            raise HTTPException(status_code=400, detail=f"Invalid image format: {str(e)}")
        
        # Validate image
        print("[PYTHON_LIVENESS_STEP_4] Validating image...")
        is_valid, error_msg = validate_image(image)
        if not is_valid:
            print(f"[PYTHON_LIVENESS_ERROR] Image validation failed: {error_msg}")
            raise HTTPException(status_code=400, detail=error_msg or "Invalid image")
        print("[PYTHON_LIVENESS_STEP_4] Image validation passed")
        
        # Detect liveness using service
        print(f"[PYTHON_LIVENESS_STEP_5] Starting liveness detection for file: {file.filename}")
        logger.info(f"Processing liveness detection for file: {file.filename}")
        liveness_start = time.time()
        result = detect_liveness(image, is_video=is_video)
        liveness_time = time.time() - liveness_start
        
        print(f"[PYTHON_LIVENESS_STEP_5] Liveness detection completed in {liveness_time:.2f}s")
        print(f"[PYTHON_LIVENESS_RESULT] Detection results:")
        print(f"  - Liveness Status: {result.get('liveness', 'unknown')}")
        print(f"  - Confidence: {result.get('confidence', 0.0):.3f}")
        print(f"  - Quality Score: {result.get('quality_score', 0.0):.3f}")
        print(f"  - Spoof Type: {result.get('spoof_type', 'None')}")
        
        total_time = time.time() - request_start
        print(f"[PYTHON_LIVENESS_SUCCESS] Total processing time: {total_time:.2f}s")
        print("=== PYTHON LIVENESS DETECTION COMPLETED ===\\n")
        
        return result
        
    except HTTPException:
        total_time = time.time() - request_start
        print(f"[PYTHON_LIVENESS_ERROR] HTTPException after {total_time:.2f}s")
        print("=== PYTHON LIVENESS DETECTION FAILED ===\\n")
        raise
    except Exception as e:
        total_time = time.time() - request_start
        print(f"[PYTHON_LIVENESS_ERROR] Unexpected error after {total_time:.2f}s: {str(e)}")
        print("=== PYTHON LIVENESS DETECTION FAILED ===\\n")
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
    request_start = time.time()
    print("=== PYTHON FACE MATCHING STARTED ===")
    print(f"[PYTHON_FACE_MATCH_START] Received files: ID={id_photo.filename}, Selfie={selfie.filename}")
    print(f"[PYTHON_FACE_MATCH_START] Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    log_memory_usage("Face matching start")
    
    # Initialize variables for cleanup
    id_image = None
    selfie_image = None
    id_photo_contents = None
    selfie_contents = None
    
    try:
        # Read both files with error handling
        print("[PYTHON_FACE_MATCH_STEP_1] Reading file contents...")
        try:
            id_photo_contents = await id_photo.read()
            selfie_contents = await selfie.read()
        except Exception as e:
            print(f"[PYTHON_FACE_MATCH_ERROR] Failed to read uploaded files: {str(e)}")
            raise HTTPException(status_code=400, detail=f"Failed to read uploaded files: {str(e)}")
        
        id_size = len(id_photo_contents) if id_photo_contents else 0
        selfie_size = len(selfie_contents) if selfie_contents else 0
        print(f"[PYTHON_FACE_MATCH_STEP_1] Files read - ID: {id_size} bytes, Selfie: {selfie_size} bytes")
        
        if not id_photo_contents:
            print("[PYTHON_FACE_MATCH_ERROR] Empty ID photo provided")
            raise HTTPException(status_code=400, detail="Empty ID photo provided")
        if not selfie_contents:
            print("[PYTHON_FACE_MATCH_ERROR] Empty selfie provided")
            raise HTTPException(status_code=400, detail="Empty selfie provided")
        
        # Check file sizes (prevent memory issues)
        max_file_size = 10 * 1024 * 1024  # 10MB
        if id_size > max_file_size or selfie_size > max_file_size:
            print(f"[PYTHON_FACE_MATCH_ERROR] File too large - ID: {id_size}, Selfie: {selfie_size}")
            raise HTTPException(status_code=400, detail=f"File too large. Max size: {max_file_size/1024/1024}MB")
        
        logger.info(f"[FACE_MATCH_API] Received files: ID={id_photo.filename} ({len(id_photo_contents)} bytes), Selfie={selfie.filename} ({len(selfie_contents)} bytes)")
        
        # Convert to PIL Images with safe processing
        print("[PYTHON_FACE_MATCH_STEP_2] Converting images to PIL format...")
        try:
            # Process ID photo
            id_image = Image.open(io.BytesIO(id_photo_contents))
            print(f"[PYTHON_FACE_MATCH_STEP_2] ID photo opened: {id_image.size} pixels, mode: {id_image.mode}")
            if id_image.mode != 'RGB':
                print(f"[PYTHON_FACE_MATCH_STEP_2] Converting ID photo from {id_image.mode} to RGB")
                id_image = id_image.convert('RGB')
            
            # Process Selfie
            selfie_image = Image.open(io.BytesIO(selfie_contents))
            print(f"[PYTHON_FACE_MATCH_STEP_2] Selfie opened: {selfie_image.size} pixels, mode: {selfie_image.mode}")
            if selfie_image.mode != 'RGB':
                print(f"[PYTHON_FACE_MATCH_STEP_2] Converting selfie from {selfie_image.mode} to RGB")
                selfie_image = selfie_image.convert('RGB')
                
        except MemoryError as e:
            print(f"[PYTHON_FACE_MATCH_ERROR] Memory error opening images: {str(e)}")
            raise HTTPException(status_code=413, detail="Images too large for processing. Please use smaller images.")
        except Exception as e:
            print(f"[PYTHON_FACE_MATCH_ERROR] Failed to open images: {str(e)}")
            logger.error(f"Failed to open images: {str(e)}")
            raise HTTPException(status_code=400, detail=f"Invalid image format: {str(e)}")
        
        # Clear file contents from memory
        id_photo_contents = None
        selfie_contents = None
        gc.collect()
        log_memory_usage("After image conversion")
        
        # Validate images
        print("[PYTHON_FACE_MATCH_STEP_3] Validating images...")
        is_valid, error_msg = validate_image(id_image)
        if not is_valid:
            print(f"[PYTHON_FACE_MATCH_ERROR] Invalid ID photo: {error_msg}")
            raise HTTPException(status_code=400, detail=f"Invalid ID photo: {error_msg}")
        
        is_valid, error_msg = validate_image(selfie_image)
        if not is_valid:
            print(f"[PYTHON_FACE_MATCH_ERROR] Invalid selfie: {error_msg}")
            raise HTTPException(status_code=400, detail=f"Invalid selfie: {error_msg}")
        print("[PYTHON_FACE_MATCH_STEP_3] Image validation passed")
        
        # Resize images to optimize face detection speed (maintains aspect ratio)
        print("[PYTHON_FACE_MATCH_STEP_4] Optimizing image sizes for processing...")
        resize_start = time.time()
        logger.info(f"Resizing images for optimal processing...")
        old_id_size = id_image.size
        old_selfie_size = selfie_image.size
        
        try:
            id_image = resize_image_if_needed(id_image, max_size=(640, 480))
            selfie_image = resize_image_if_needed(selfie_image, max_size=(640, 480))
        except Exception as e:
            print(f"[PYTHON_FACE_MATCH_ERROR] Failed to resize images: {str(e)}")
            raise HTTPException(status_code=500, detail=f"Failed to process images: {str(e)}")
            
        resize_time = time.time() - resize_start
        print(f"[PYTHON_FACE_MATCH_STEP_4] Images resized in {resize_time:.2f}s:")
        print(f"  - ID photo: {old_id_size} → {id_image.size}")
        print(f"  - Selfie: {old_selfie_size} → {selfie_image.size}")
        logger.info(f"[FACE_MATCH_API] Images resized in {resize_time:.2f}s: ID={id_image.size}, Selfie={selfie_image.size}")
        
        log_memory_usage("After image resizing")
        
        # Match faces using service with safe processing and timeout
        print("[PYTHON_FACE_MATCH_STEP_5] Starting DeepFace matching with 120s timeout...")
        logger.info(f"[FACE_MATCH_API] Starting face matching operation with 120s timeout...")
        match_start = time.time()
        
        # Use safe processing wrapper
        result, error_msg = safe_image_processing(
            lambda: run_with_timeout(
                lambda: match_faces(id_image, selfie_image),
                timeout_seconds=120
            )
        )
        
        if error_msg:
            print(f"[PYTHON_FACE_MATCH_ERROR] Safe processing failed: {error_msg}")
            raise HTTPException(status_code=500, detail=f"Face matching processing failed: {error_msg}")
        
        if result is None:
            print("[PYTHON_FACE_MATCH_ERROR] Face matching returned None result")
            raise HTTPException(status_code=500, detail="Face matching failed to produce results")
        
        # Handle timeout result
        actual_result, timeout_error = result
        match_time = time.time() - match_start
        
        if timeout_error:
            print(f"[PYTHON_FACE_MATCH_ERROR] Face matching timed out after {match_time:.2f}s: {timeout_error}")
            logger.error(f"[FACE_MATCH_API] Face matching timed out after {match_time:.2f}s: {timeout_error}")
            raise HTTPException(status_code=504, detail=f"Face matching operation timed out. Please try again with smaller images.")
        
        print(f"[PYTHON_FACE_MATCH_STEP_5] Face matching completed in {match_time:.2f}s")
        print(f"[PYTHON_FACE_MATCH_RESULT] Matching results:")
        print(f"  - Match Score: {actual_result.get('similarity_score', 0.0):.4f}")
        print(f"  - Is Match: {actual_result.get('is_match', False)}")
        print(f"  - ID Photo Quality: {actual_result.get('id_photo_quality', 0.0):.3f}")
        print(f"  - Selfie Quality: {actual_result.get('selfie_quality', 0.0):.3f}")
        print(f"  - Face Found in ID: {actual_result.get('face_found_in_id', False)}")
        print(f"  - Face Found in Selfie: {actual_result.get('face_found_in_selfie', False)}")
        
        total_time = time.time() - request_start
        print(f"[PYTHON_FACE_MATCH_SUCCESS] Total processing time: {total_time:.2f}s (resize: {resize_time:.2f}s, matching: {match_time:.2f}s)")
        print("=== PYTHON FACE MATCHING COMPLETED ===\\n")
        logger.info(f"[FACE_MATCH_API] Face matching completed in {match_time:.2f}s (total request: {total_time:.2f}s). Result: {actual_result}")
        
        log_memory_usage("Face matching completed")
        
        return actual_result
        
    except HTTPException:
        total_time = time.time() - request_start
        print(f"[PYTHON_FACE_MATCH_ERROR] HTTPException after {total_time:.2f}s")
        print("=== PYTHON FACE MATCHING FAILED ===\\n")
        raise
    except MemoryError as e:
        total_time = time.time() - request_start
        print(f"[PYTHON_FACE_MATCH_ERROR] Memory error after {total_time:.2f}s: {str(e)}")
        print("=== PYTHON FACE MATCHING FAILED (MEMORY) ===\\n")
        logger.error(f"[FACE_MATCH_API] Memory error after {total_time:.2f}s: {str(e)}")
        raise HTTPException(status_code=413, detail="Not enough memory to process images. Please use smaller images.")
    except Exception as e:
        total_time = time.time() - request_start
        print(f"[PYTHON_FACE_MATCH_ERROR] Unexpected error after {total_time:.2f}s: {str(e)}")
        print("=== PYTHON FACE MATCHING FAILED ===\\n")
        logger.error(f"[FACE_MATCH_API] Face matching failed after {total_time:.2f}s: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Face matching failed: {str(e)}")
    finally:
        # Cleanup memory
        try:
            if 'id_image' in locals() and id_image is not None:
                id_image.close()
            if 'selfie_image' in locals() and selfie_image is not None:
                selfie_image.close()
            # Clear large variables
            id_photo_contents = None
            selfie_contents = None
            gc.collect()
            log_memory_usage("After cleanup")
        except Exception as cleanup_error:
            print(f"[PYTHON_FACE_MATCH_CLEANUP_ERROR] Failed to cleanup: {cleanup_error}")


@router.post("/document-authenticity")
async def check_document_authenticity_endpoint(file: UploadFile = File(...)):
    """
    Check document authenticity by detecting tampering, holograms, texture consistency, etc.
    Returns authenticity status, score, and flags for various checks.
    """
    request_start = time.time()
    print("=== PYTHON DOCUMENT AUTHENTICITY CHECK STARTED ===")
    print(f"[PYTHON_AUTHENTICITY_START] Received document: {file.filename}")
    print(f"[PYTHON_AUTHENTICITY_START] Content type: {file.content_type}")
    print(f"[PYTHON_AUTHENTICITY_START] Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    
    try:
        # Read file content
        print("[PYTHON_AUTHENTICITY_STEP_1] Reading file content...")
        contents = await file.read()
        file_size = len(contents) if contents else 0
        print(f"[PYTHON_AUTHENTICITY_STEP_1] File content read: {file_size} bytes")
        
        if not contents:
            print("[PYTHON_AUTHENTICITY_ERROR] Empty file provided")
            raise HTTPException(status_code=400, detail="Empty file provided")
        
        # Convert to PIL Image
        print("[PYTHON_AUTHENTICITY_STEP_2] Converting to PIL Image...")
        try:
            image = Image.open(io.BytesIO(contents))
            print(f"[PYTHON_AUTHENTICITY_STEP_2] Image opened: {image.size} pixels, mode: {image.mode}")
            # Convert to RGB if necessary
            if image.mode != 'RGB':
                print(f"[PYTHON_AUTHENTICITY_STEP_2] Converting from {image.mode} to RGB mode")
                image = image.convert('RGB')
        except Exception as e:
            print(f"[PYTHON_AUTHENTICITY_ERROR] Failed to open image: {str(e)}")
            logger.error(f"Failed to open image: {str(e)}")
            raise HTTPException(status_code=400, detail=f"Invalid image format: {str(e)}")
        
        # Validate image
        print("[PYTHON_AUTHENTICITY_STEP_3] Validating image...")
        is_valid, error_msg = validate_image(image)
        if not is_valid:
            print(f"[PYTHON_AUTHENTICITY_ERROR] Image validation failed: {error_msg}")
            raise HTTPException(status_code=400, detail=error_msg or "Invalid image")
        print("[PYTHON_AUTHENTICITY_STEP_3] Image validation passed")
        
        # Check authenticity using service
        print(f"[PYTHON_AUTHENTICITY_STEP_4] Starting authenticity analysis for file: {file.filename}")
        logger.info(f"Processing document authenticity check for file: {file.filename}")
        authenticity_start = time.time()
        result = check_authenticity(image)
        authenticity_time = time.time() - authenticity_start
        
        print(f"[PYTHON_AUTHENTICITY_STEP_4] Authenticity analysis completed in {authenticity_time:.2f}s")
        print(f"[PYTHON_AUTHENTICITY_RESULT] Analysis results:")
        print(f"  - Is Authentic: {result.get('is_authentic', False)}")
        print(f"  - Authenticity Score: {result.get('authenticity_score', 0.0):.4f}")
        flags = result.get('flags', {})
        print(f"  - Hologram Detected: {flags.get('hologram_detected', False)}")
        print(f"  - Texture Consistent: {flags.get('texture_consistent', False)}")
        print(f"  - Tamper Detected: {flags.get('tamper_detected', False)}")
        print(f"  - Font Consistent: {flags.get('font_consistent', False)}")
        print(f"  - UV Pattern Valid: {flags.get('uv_pattern_valid', 'N/A')}")
        
        total_time = time.time() - request_start
        print(f"[PYTHON_AUTHENTICITY_SUCCESS] Total processing time: {total_time:.2f}s")
        print("=== PYTHON DOCUMENT AUTHENTICITY CHECK COMPLETED ===\\n")
        
        return result
        
    except HTTPException:
        total_time = time.time() - request_start
        print(f"[PYTHON_AUTHENTICITY_ERROR] HTTPException after {total_time:.2f}s")
        print("=== PYTHON DOCUMENT AUTHENTICITY CHECK FAILED ===\\n")
        raise
    except Exception as e:
        total_time = time.time() - request_start
        print(f"[PYTHON_AUTHENTICITY_ERROR] Unexpected error after {total_time:.2f}s: {str(e)}")
        print("=== PYTHON DOCUMENT AUTHENTICITY CHECK FAILED ===\\n")
        logger.error(f"Document authenticity check failed: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500, detail=f"Document authenticity check failed: {str(e)}"
        )

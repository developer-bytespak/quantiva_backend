"""
Face Matching Service for KYC Verification
==========================================
Compares faces between ID photo and selfie using the OPTIMIZED FaceEngine.
Uses Facenet512 + OpenCV (with RetinaFace backup) for fast, accurate matching.
"""

import logging
import time
from typing import Dict, Optional, Tuple, Any
from PIL import Image
import numpy as np

# Use optimized engine for better performance on resource-constrained servers
from src.services.kyc.face_engine_optimized import get_face_engine, FaceEngineOptimized

logger = logging.getLogger(__name__)

# Lazy OpenCV loader
_cv2 = None


def _get_cv2():
    """Lazy load OpenCV"""
    global _cv2
    if _cv2 is None:
        try:
            import cv2
            _cv2 = cv2
        except ImportError as e:
            logger.error(f"OpenCV not available: {e}")
    return _cv2


def pil_to_bgr(pil_image: Image.Image) -> np.ndarray:
    """Convert PIL Image to BGR numpy array for OpenCV/face engine"""
    cv2 = _get_cv2()
    if cv2 is None:
        raise RuntimeError("OpenCV not available")
    
    # Ensure RGB mode
    if pil_image.mode != 'RGB':
        pil_image = pil_image.convert('RGB')
    
    # Convert to numpy
    rgb_array = np.array(pil_image, dtype=np.uint8)
    
    # Convert RGB to BGR
    bgr_array = cv2.cvtColor(rgb_array, cv2.COLOR_RGB2BGR)
    
    return bgr_array


def match_faces(id_photo: Image.Image, selfie: Image.Image) -> Dict[str, Any]:
    """
    Enhanced face matching between ID photo and selfie with preprocessing,
    quality assessment, liveness detection, and adaptive thresholds.
    
    Args:
        id_photo: PIL Image of ID document photo
        selfie: PIL Image of selfie
        
    Returns:
        Dictionary with:
        - similarity: float (0-1)
        - is_match: bool
        - decision: "approved" | "review" | "rejected"
        - confidence: float (0-1)
        - threshold: float
        - engine: str
        - id_face_quality: dict
        - selfie_face_quality: dict
        - liveness: dict
        - metrics: dict (individual similarity scores)
        - error: str (if failed)
    """
    import os
    import uuid
    
    logger.info("=" * 60)
    logger.info("🎯 [KYC] match_faces() called")
    logger.info(f"   ID Photo: {id_photo.size}, mode={id_photo.mode}")
    logger.info(f"   Selfie: {selfie.size}, mode={selfie.mode}")
    logger.info("=" * 60)
    
    total_start = time.time()
    
    try:
        # Convert to BGR
        logger.info("🔄 [KYC] Converting images to BGR...")
        t = time.time()
        id_bgr = pil_to_bgr(id_photo)
        selfie_bgr = pil_to_bgr(selfie)
        logger.info(f"   Conversion done: {time.time()-t:.2f}s")

        # Get face engine and perform enhanced verification
        logger.info("🔄 [KYC] Getting face engine...")
        engine = get_face_engine()
        
        logger.info("🔄 [KYC] Calling verify_faces()...")
        result = engine.verify_faces(id_bgr, selfie_bgr)

        # Debug crop saving - ONLY in development (disabled in production/Render)
        # Set SAVE_FACE_CROPS=true in .env to enable local debugging
        save_crops_enabled = os.environ.get("SAVE_FACE_CROPS", "false").lower() == "true"
        id_crop_path = None
        selfie_crop_path = None

        if save_crops_enabled:
            output_dir = os.environ.get("KYC_FACE_CROP_DIR", "./kyc_face_crops")
            os.makedirs(output_dir, exist_ok=True)

            # Clean old crops before saving new ones
            try:
                for old_file in os.listdir(output_dir):
                    if old_file.endswith('.jpg') or old_file.endswith('.jpeg'):
                        old_path = os.path.join(output_dir, old_file)
                        os.remove(old_path)
                logger.info(f"Cleaned old face crops from {output_dir}")
            except Exception as e:
                logger.warning(f"Failed to clean old crops: {e}")

            def save_crop(bgr_img, face_result, prefix):
                if not face_result or not face_result.get("bbox"):
                    logger.info(f"No face detected for {prefix}, skipping crop save.")
                    return None
                bbox = face_result["bbox"]
                x1, y1, x2, y2 = [int(c) for c in bbox]
                crop = bgr_img[y1:y2, x1:x2]
                
                # Convert to grayscale for consistency with face matching
                import cv2
                crop_gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
                
                crop_path = os.path.join(output_dir, f"{prefix}_crop.jpg")
                try:
                    cv2.imwrite(crop_path, crop_gray)
                    logger.info(f"Saved grayscale cropped face for {prefix} at: {crop_path}")
                    return crop_path
                except Exception as e:
                    logger.warning(f"Failed to save crop for {prefix}: {e}")
                    return None

            id_crop_path = save_crop(id_bgr, result.get("face1"), "document")
            selfie_crop_path = save_crop(selfie_bgr, result.get("face2"), "selfie")
        else:
            logger.debug("Face crop saving disabled (set SAVE_FACE_CROPS=true to enable)")

        if not result["success"]:
            logger.warning(f"Enhanced face verification failed: {result.get('error')}")
            return {
                "similarity": 0.0,
                "is_match": False,
                "decision": "rejected",
                "confidence": 0.0,
                "error": result.get("error"),
                "id_face_quality": result.get("face1", {}).get("quality") if result.get("face1") else None,
                "selfie_face_quality": result.get("face2", {}).get("quality") if result.get("face2") else None,
                "liveness": result.get("face2", {}).get("liveness") if result.get("face2") else None,
                "document_crop_path": id_crop_path,
                "selfie_crop_path": selfie_crop_path,
                "engine": result.get("engine_type", "unknown")
            }

        match_data = result["match"]
        face1_data = result["face1"]
        face2_data = result["face2"]
        liveness_data = face2_data.get("liveness", {})

        # Enhanced decision logic with liveness integration
        similarity = match_data["similarity"]
        threshold_used = match_data["threshold_used"]
        liveness_confidence = liveness_data.get("confidence", 0.0)
        is_live = liveness_data.get("is_live", False)
        
        # Determine final decision - simple approved/rejected only
        # >= 50% similarity = approved, < 50% = rejected
        if similarity >= 0.50:
            decision = "approved"
        else:
            decision = "rejected"
        
        # Calculate confidence based on multiple factors
        base_confidence = similarity
        liveness_boost = 0.1 if is_live else -0.1
        quality_boost = 0.05 if face1_data.get("quality", {}).get("overall_quality") == "good" else 0
        
        final_confidence = max(0.0, min(1.0, base_confidence + liveness_boost + quality_boost))

        # Log detailed results
        logger.info(
            f"Enhanced face matching: similarity={similarity:.3f}, "
            f"decision={decision}, engine={result.get('engine_type')}, "
            f"liveness={is_live} ({liveness_confidence:.2f})"
        )
        
        # Log individual metrics if available
        if match_data.get("metrics"):
            metrics = match_data["metrics"]
            logger.info(f"Similarity breakdown: cosine={metrics.get('cosine', 0):.3f}, "
                       f"euclidean={metrics.get('euclidean', 0):.3f}, "
                       f"manhattan={metrics.get('manhattan', 0):.3f}")

        total_time = time.time() - total_start
        logger.info("=" * 60)
        logger.info(f"✅ [KYC] match_faces() completed: {decision.upper()}")
        logger.info(f"   Similarity: {similarity:.3f}, Threshold: {threshold_used}")
        logger.info(f"   Total time: {total_time:.2f}s")
        logger.info("=" * 60)
        
        return {
            "similarity": float(similarity),
            "is_match": decision == "approved",
            "decision": decision,
            "confidence": float(final_confidence),
            "threshold": float(threshold_used),
            "engine": result.get("engine_type", "unknown"),
            "id_face_quality": face1_data.get("quality"),
            "selfie_face_quality": face2_data.get("quality"),
            "liveness": liveness_data,
            "metrics": match_data.get("metrics", {}),
            "document_crop_path": id_crop_path,
            "selfie_crop_path": selfie_crop_path,
            "processing_time_seconds": round(total_time, 2)
        }

    except Exception as e:
        total_time = time.time() - total_start
        logger.error(f"❌ [KYC] match_faces() FAILED after {total_time:.2f}s: {str(e)}", exc_info=True)
        return {
            "similarity": 0.0,
            "is_match": False,
            "decision": "rejected",
            "confidence": 0.0,
            "error": str(e),
            "processing_time_seconds": round(total_time, 2)
        }


def verify_face_quality(image: Image.Image, is_webcam: bool = False) -> Tuple[bool, float, Optional[Dict]]:
    """
    Enhanced face quality verification.
    
    Args:
        image: PIL Image object
        is_webcam: True if webcam selfie (more lenient standards)
        
    Returns:
        Tuple of (is_acceptable, quality_score, quality_details)
    """
    try:
        # Convert to BGR
        bgr = pil_to_bgr(image)
        
        # Use optimized quality verification
        from src.services.kyc.face_engine_optimized import verify_face_quality as _verify_quality
        return _verify_quality(bgr, is_webcam)
        
    except Exception as e:
        logger.error(f"Face quality verification failed: {str(e)}")
        return False, 0.0, {"error": str(e)}


def extract_face_embedding(image: Image.Image) -> Optional[np.ndarray]:
    """
    Extract face embedding from image.
    
    Args:
        image: PIL Image object
        
    Returns:
        Face embedding as numpy array, or None if no face detected
    """
    try:
        # Convert to BGR
        bgr = pil_to_bgr(image)
        
        # Get face engine and detect face
        engine = get_face_engine()
        face = engine.get_best_face(bgr)
        
        if face is None:
            logger.warning("No face detected in image")
            return None
        
        if face.embedding is None:
            logger.warning("Face detected but no embedding extracted")
            return None
        
        logger.info(f"Face embedding extracted (dim: {len(face.embedding)}, engine: {engine.engine_name})")
        return face.embedding
        
    except Exception as e:
        logger.error(f"Face embedding extraction failed: {str(e)}", exc_info=True)
        return None


def get_engine_status() -> Dict[str, Any]:
    """
    Get current face engine status.
    
    Returns:
        Dictionary with engine name, initialization status, and capabilities
    """
    try:
        engine = get_face_engine()
        return {
            "engine": "deepface-facenet512-optimized",
            "initialized": engine._initialized,
            "has_liveness": True,
            "has_preprocessing": True,
            "optimized": True,
            "detectors": ["opencv", "retinaface (lazy)"],
        }
    except Exception as e:
        return {
            "engine": "unknown",
            "initialized": False,
            "error": str(e)
        }

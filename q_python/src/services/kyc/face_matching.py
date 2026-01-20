"""
Face Matching Service for KYC Verification
==========================================
Compares faces between ID photo and selfie using the unified FaceEngine.
"""

import logging
from typing import Dict, Optional, Tuple, Any
from PIL import Image
import numpy as np

from src.services.kyc.insightface_engine import get_face_engine, FaceEngine

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
    Match faces between ID photo and selfie.
    
    Args:
        id_photo: PIL Image of ID document photo
        selfie: PIL Image of selfie
        
    Returns:
        Dictionary with:
        - similarity: float (0-1)
        - is_match: bool
        - decision: "accept" | "review" | "reject"
        - confidence: float (0-1)
        - threshold: float
        - engine: str
        - id_face_quality: dict
        - selfie_face_quality: dict
        - error: str (if failed)
    """
    try:
        # Convert to BGR
        id_bgr = pil_to_bgr(id_photo)
        selfie_bgr = pil_to_bgr(selfie)
        
        # Get face engine and perform verification
        engine = get_face_engine()
        result = engine.verify_faces(id_bgr, selfie_bgr)
        
        if not result["success"]:
            logger.warning(f"Face verification failed: {result.get('error')}")
            return {
                "similarity": 0.0,
                "is_match": False,
                "decision": "reject",
                "confidence": 0.0,
                "error": result.get("error"),
                "id_face_quality": result.get("face1", {}).get("quality") if result.get("face1") else None,
                "selfie_face_quality": result.get("face2", {}).get("quality") if result.get("face2") else None,
            }
        
        match_data = result["match"]
        
        logger.info(
            f"Face matching: similarity={match_data['similarity']:.3f}, "
            f"decision={match_data['decision']}, engine={match_data['engine']}"
        )
        
        return {
            "similarity": float(match_data["similarity"]),
            "is_match": bool(match_data["is_match"]),
            "decision": match_data["decision"],
            "confidence": float(match_data["confidence"]),
            "threshold": float(match_data["threshold"]),
            "engine": match_data["engine"],
            "id_face_quality": result.get("face1", {}).get("quality"),
            "selfie_face_quality": result.get("face2", {}).get("quality"),
        }
        
    except Exception as e:
        logger.error(f"Face matching failed: {str(e)}", exc_info=True)
        return {
            "similarity": 0.0,
            "is_match": False,
            "decision": "reject",
            "confidence": 0.0,
            "error": str(e)
        }


def verify_face_quality(image: Image.Image) -> Tuple[bool, float, Optional[Dict]]:
    """
    Verify face quality in an image.
    
    Args:
        image: PIL Image object
        
    Returns:
        Tuple of (is_acceptable, quality_score, quality_details)
    """
    try:
        # Convert to BGR
        bgr = pil_to_bgr(image)
        
        # Get face engine and detect face
        engine = get_face_engine()
        face = engine.get_best_face(bgr)
        
        if face is None:
            return False, 0.0, {"error": "No face detected"}
        
        if face.quality is None:
            return False, 0.0, {"error": "Could not assess quality"}
        
        return (
            face.quality.is_acceptable,
            face.quality.overall_score,
            face.quality.to_dict()
        )
        
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
        Dictionary with engine name, initialization status, and thresholds
    """
    try:
        engine = get_face_engine()
        return {
            "engine": engine.engine_name,
            "initialized": engine._initialized,
            "thresholds": engine.thresholds,
        }
    except Exception as e:
        return {
            "engine": "unknown",
            "initialized": False,
            "error": str(e)
        }

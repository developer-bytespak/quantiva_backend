"""
Liveness Detection Service for KYC Verification
================================================
Verifies that a selfie is from a live person using multi-modal analysis.
Integrates with FaceEngine for face quality assessment.

Detection Methods:
- Texture analysis (gradient variance)
- Depth cues (focus variation)
- Reflection analysis (specular highlights)
- Face quality (pose, occlusion)
"""

import logging
from typing import Dict, Optional, Any
from PIL import Image
import numpy as np

from src.services.kyc.insightface_engine import get_face_engine

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


# Liveness thresholds
LIVENESS_THRESHOLD_LIVE = 0.65      # Above this = live
LIVENESS_THRESHOLD_SPOOF = 0.35    # Below this = spoof


def detect_liveness(image: Image.Image, is_video: bool = False) -> Dict[str, Any]:
    """
    Detect liveness from selfie photo with multi-modal analysis.
    
    Args:
        image: PIL Image object
        is_video: Whether input is from video (enables more analysis)
        
    Returns:
        Dictionary with:
        - liveness: "live" | "spoof" | "unclear"
        - confidence: float (0-1)
        - spoof_type: str | None
        - quality_score: float
        - face_quality: dict | None
        - texture_score: float
        - depth_score: float
        - reflection_score: float
    """
    cv2 = _get_cv2()
    if cv2 is None:
        return _error_response("OpenCV not available")
    
    try:
        # Convert to BGR for processing
        if image.mode != 'RGB':
            image = image.convert('RGB')
        
        rgb_array = np.array(image, dtype=np.uint8)
        bgr_array = cv2.cvtColor(rgb_array, cv2.COLOR_RGB2BGR)
        
        # Get face detection with quality from engine
        engine = get_face_engine()
        face = engine.get_best_face(bgr_array)
        
        face_quality_dict = None
        face_region = None
        
        if face is not None:
            # Extract face region for analysis
            x1, y1, x2, y2 = [int(c) for c in face.bbox]
            h, w = bgr_array.shape[:2]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)
            face_region = bgr_array[y1:y2, x1:x2]
            
            if face.quality is not None:
                face_quality_dict = face.quality.to_dict()
        else:
            logger.warning("No face detected for liveness analysis")
            return {
                "liveness": "unclear",
                "confidence": 0.0,
                "spoof_type": None,
                "quality_score": 0.0,
                "face_quality": None,
                "error": "No face detected"
            }
        
        # Use face region if available, otherwise full image
        analysis_region = face_region if face_region is not None and face_region.size > 0 else bgr_array
        
        # Calculate basic quality score
        quality_score = _calculate_quality_score(analysis_region)
        
        if quality_score < 0.3:
            logger.warning(f"Image quality too low: {quality_score:.3f}")
            return {
                "liveness": "unclear",
                "confidence": quality_score,
                "spoof_type": None,
                "quality_score": float(quality_score),
                "face_quality": face_quality_dict,
                "error": "Image quality too low"
            }
        
        # Perform liveness analysis
        texture_score = _analyze_texture(analysis_region)
        depth_score = _analyze_depth_cues(analysis_region)
        reflection_score = _analyze_reflection(analysis_region)
        
        # Get pose/occlusion factor from face quality
        pose_factor = 1.0
        if face_quality_dict:
            pose_quality = face_quality_dict.get("pose_quality", 0.7)
            occlusion = face_quality_dict.get("occlusion_score", 0.7)
            pose_factor = (pose_quality + occlusion) / 2
        
        # Combine scores (weighted average)
        base_score = (
            texture_score * 0.40 +
            depth_score * 0.35 +
            reflection_score * 0.25
        )
        
        # Apply pose/occlusion factor
        liveness_score = base_score * (0.7 + 0.3 * pose_factor)
        
        # Determine liveness status
        if liveness_score >= LIVENESS_THRESHOLD_LIVE:
            liveness_status = "live"
            spoof_type = None
        elif liveness_score <= LIVENESS_THRESHOLD_SPOOF:
            liveness_status = "spoof"
            spoof_type = _detect_spoof_type(analysis_region, texture_score, depth_score, reflection_score)
        else:
            liveness_status = "unclear"
            spoof_type = None
        
        logger.info(
            f"Liveness: status={liveness_status}, score={liveness_score:.3f}, "
            f"texture={texture_score:.2f}, depth={depth_score:.2f}, reflection={reflection_score:.2f}"
        )
        
        return {
            "liveness": liveness_status,
            "confidence": float(liveness_score),
            "spoof_type": spoof_type,
            "quality_score": float(quality_score),
            "face_quality": face_quality_dict,
            "texture_score": float(texture_score),
            "depth_score": float(depth_score),
            "reflection_score": float(reflection_score),
        }
        
    except Exception as e:
        logger.error(f"Liveness detection failed: {str(e)}", exc_info=True)
        return _error_response(str(e))


def _error_response(error: str) -> Dict[str, Any]:
    """Create error response"""
    return {
        "liveness": "unclear",
        "confidence": 0.0,
        "spoof_type": None,
        "quality_score": 0.0,
        "face_quality": None,
        "error": error
    }


def _calculate_quality_score(image: np.ndarray) -> float:
    """Calculate basic image quality score"""
    cv2 = _get_cv2()
    if cv2 is None:
        return 0.5
    
    try:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
        
        # Blur score (Laplacian variance)
        blur = cv2.Laplacian(gray, cv2.CV_64F).var()
        blur_score = min(1.0, blur / 200.0)
        
        # Brightness score
        brightness = np.mean(gray)
        brightness_score = 1.0 - abs(brightness - 127) / 127
        
        # Contrast score
        contrast = np.std(gray)
        contrast_score = min(1.0, contrast / 60.0)
        
        # Combined score
        quality = blur_score * 0.4 + brightness_score * 0.3 + contrast_score * 0.3
        return float(quality)
        
    except Exception:
        return 0.5


def _analyze_texture(image: np.ndarray) -> float:
    """
    Analyze texture for spoof detection.
    Real faces have more texture variation than printed photos.
    Higher score = more likely live.
    """
    cv2 = _get_cv2()
    if cv2 is None:
        return 0.5
    
    try:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
        
        # Calculate gradient magnitude
        grad_x = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
        grad_y = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
        gradient_magnitude = np.sqrt(grad_x**2 + grad_y**2)
        
        # Variance of gradient (real faces have more variation)
        texture_variance = np.var(gradient_magnitude)
        
        # Normalize (typical range 500-3000 for real faces)
        texture_score = min(1.0, max(0.0, (texture_variance - 200) / 2000))
        
        return float(texture_score)
        
    except Exception as e:
        logger.debug(f"Texture analysis failed: {e}")
        return 0.5


def _analyze_depth_cues(image: np.ndarray) -> float:
    """
    Analyze depth cues for spoof detection.
    Real faces have natural depth variation; flat photos don't.
    Higher score = more likely live.
    """
    cv2 = _get_cv2()
    if cv2 is None:
        return 0.5
    
    try:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
        
        # Focus variation across regions (real faces have variable focus)
        h, w = gray.shape
        if h < 60 or w < 60:
            return 0.5
        
        # Divide into 3x3 grid and check blur variance
        cell_h, cell_w = h // 3, w // 3
        blur_scores = []
        
        for i in range(3):
            for j in range(3):
                cell = gray[i*cell_h:(i+1)*cell_h, j*cell_w:(j+1)*cell_w]
                blur = cv2.Laplacian(cell, cv2.CV_64F).var()
                blur_scores.append(blur)
        
        # Variance of blur scores (flat photos have uniform blur)
        blur_variance = np.var(blur_scores)
        
        # Normalize (typical range 50-500 for real faces)
        depth_score = min(1.0, max(0.0, blur_variance / 300))
        
        return float(depth_score)
        
    except Exception as e:
        logger.debug(f"Depth analysis failed: {e}")
        return 0.5


def _analyze_reflection(image: np.ndarray) -> float:
    """
    Analyze reflection patterns for spoof detection.
    Printed photos often have unnatural specular reflections.
    Higher score = more likely live.
    """
    cv2 = _get_cv2()
    if cv2 is None:
        return 0.5
    
    try:
        # Convert to HSV for better highlight detection
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        
        # Extract value (brightness) channel
        v_channel = hsv[:, :, 2]
        
        # Detect highlights (very bright spots)
        _, highlights = cv2.threshold(v_channel, 240, 255, cv2.THRESH_BINARY)
        
        # Calculate highlight percentage
        highlight_ratio = np.sum(highlights > 0) / highlights.size
        
        # Check for artificial reflection patterns
        # Printed photos often have large uniform bright areas
        
        # Find contours of highlights
        contours, _ = cv2.findContours(highlights, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        # Large uniform highlights are suspicious
        suspicious_highlights = 0
        for contour in contours:
            area = cv2.contourArea(contour)
            if area > (highlights.size * 0.02):  # Large highlight
                suspicious_highlights += 1
        
        # Score: fewer suspicious highlights = more likely live
        if highlight_ratio < 0.01:
            reflection_score = 0.8  # Normal
        elif highlight_ratio < 0.05:
            reflection_score = 0.6  # Some highlights
        elif suspicious_highlights > 2:
            reflection_score = 0.3  # Suspicious pattern
        else:
            reflection_score = 0.5  # Unclear
        
        return float(reflection_score)
        
    except Exception as e:
        logger.debug(f"Reflection analysis failed: {e}")
        return 0.5


def _detect_spoof_type(
    image: np.ndarray, 
    texture_score: float, 
    depth_score: float,
    reflection_score: float
) -> Optional[str]:
    """Determine likely spoof type based on analysis scores"""
    
    # Printed photo: low texture, low depth variation
    if texture_score < 0.3 and depth_score < 0.3:
        return "printed_photo"
    
    # Screen display: low depth, unusual reflection
    if depth_score < 0.3 and reflection_score < 0.4:
        return "screen_display"
    
    # Paper mask: moderate texture, very low depth
    if texture_score > 0.3 and depth_score < 0.2:
        return "paper_mask"
    
    # General low quality
    if texture_score + depth_score + reflection_score < 1.0:
        return "low_quality_attack"
    
    return "unknown_spoof"


"""
Liveness Detection Service for verifying that a selfie is from a live person.
Uses OpenCV and DeepFace for spoof detection and quality assessment.
"""
from typing import Dict, Optional
from PIL import Image
import numpy as np
from logging import getLogger

from src.utils.image_utils import preprocess_image, validate_image, calculate_image_quality
from src.config import get_config

logger = getLogger(__name__)

# Liveness detection thresholds (from config)
LIVENESS_CONFIDENCE_THRESHOLD = get_config("liveness_confidence_threshold", 0.7)
QUALITY_THRESHOLD = get_config("quality_threshold", 0.5)

# Lazy OpenCV loader
_cv2 = None

def _get_cv2():
    global _cv2
    if _cv2 is None:
        try:
            import cv2 as _cv2mod
            _cv2 = _cv2mod
        except Exception as e:
            logger.error(f"cv2 import failed: {e}")
            _cv2 = None
    return _cv2


def detect_liveness(image: Image.Image, is_video: bool = False) -> Dict:
    """
    Detect liveness from selfie photo or video.
    
    Args:
        image: PIL Image object (or first frame if video)
        is_video: Whether the input is a video
        
    Returns:
        Dictionary with liveness status, confidence, spoof type, and quality score
    """
    try:
        # Validate image
        is_valid, error_msg = validate_image(image)
        if not is_valid:
            logger.warning(f"Image validation failed: {error_msg}")
            return {
                "liveness": "unclear",
                "confidence": 0.0,
                "spoof_type": None,
                "quality_score": 0.0,
            }
        
        # Preprocess image
        img_array = preprocess_image(image, enhance=True)

        # Calculate quality score
        quality_score = calculate_image_quality(img_array)
        
        if quality_score < QUALITY_THRESHOLD:
            logger.warning(f"Image quality too low: {quality_score:.3f}")
            return {
                "liveness": "unclear",
                "confidence": quality_score,
                "spoof_type": None,
                "quality_score": float(quality_score),
            }
        
        # Perform multiple liveness checks
        texture_score = analyze_texture(img_array)
        depth_score = analyze_depth_cues(img_array)
        reflection_score = analyze_reflection(img_array)
        
        # Combine scores (weighted average)
        liveness_score = (
            texture_score * 0.4 +
            depth_score * 0.4 +
            reflection_score * 0.2
        )
        
        # Determine liveness status
        if liveness_score >= LIVENESS_CONFIDENCE_THRESHOLD:
            liveness_status = "live"
            spoof_type = None
        elif liveness_score < 0.3:
            liveness_status = "spoof"
            spoof_type = detect_spoof_type(img_array, texture_score, depth_score)
        else:
            liveness_status = "unclear"
            spoof_type = None
        
        logger.info(f"Liveness detection: status={liveness_status}, score={liveness_score:.3f}, quality={quality_score:.3f}")
        
        return {
            "liveness": liveness_status,
            "confidence": float(liveness_score),
            "spoof_type": spoof_type,
            "quality_score": float(quality_score),
        }
        
    except Exception as e:
        logger.error(f"Liveness detection failed: {str(e)}", exc_info=True)
        return {
            "liveness": "unclear",
            "confidence": 0.0,
            "spoof_type": None,
            "quality_score": 0.0,
        }


def analyze_texture(image: np.ndarray) -> float:
    """
    Analyze texture for spoof detection.
    Real faces have more texture variation than printed photos.
    
    Args:
        image: NumPy array of image
        
    Returns:
        Texture score (0.0-1.0), higher = more likely live
    """
    try:
        cv2 = _get_cv2()
        if cv2 is None:
            logger.warning("cv2 not available, returning neutral texture score")
            return 0.5
        # Convert to grayscale
        if len(image.shape) == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        else:
            gray = image
        
        # Calculate Local Binary Pattern (LBP) variance
        # Higher variance indicates more texture (real face)
        # Lower variance indicates flat surface (photo)
        
        # Calculate gradient magnitude (texture measure)
        grad_x = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
        grad_y = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
        gradient_magnitude = np.sqrt(grad_x**2 + grad_y**2)
        
        # Calculate variance of gradient (texture variance)
        texture_variance = np.var(gradient_magnitude)
        
        # Normalize to 0-1 range (empirical threshold)
        # Real faces typically have variance > 1000
        texture_score = min(1.0, texture_variance / 2000.0)
        
        return float(texture_score)
        
    except Exception as e:
        logger.warning(f"Texture analysis failed: {str(e)}")
        return 0.5  # Neutral score on error


def analyze_depth_cues(image: np.ndarray) -> float:
    """
    Analyze depth cues for 3D face detection.
    Real faces have depth, photos are flat.
    
    Args:
        image: NumPy array of image
        
    Returns:
        Depth score (0.0-1.0), higher = more likely 3D (live)
    """
    try:
        cv2 = _get_cv2()
        if cv2 is None:
            logger.warning("cv2 not available, returning neutral depth score")
            return 0.5
        # Convert to grayscale
        if len(image.shape) == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        else:
            gray = image
        
        # Use Laplacian to detect edges (depth changes create edges)
        laplacian = cv2.Laplacian(gray, cv2.CV_64F)
        laplacian_var = laplacian.var()
        
        # Real faces have more edge variation (depth)
        # Photos have flatter surfaces
        depth_score = min(1.0, laplacian_var / 500.0)
        
        # Additional check: analyze lighting consistency
        # Real 3D faces have natural lighting gradients
        # Photos often have uniform lighting or screen reflections
        
        return float(depth_score)
        
    except Exception as e:
        logger.warning(f"Depth analysis failed: {str(e)}")
        return 0.5  # Neutral score on error


def analyze_reflection(image: np.ndarray) -> float:
    """
    Analyze reflection patterns.
    Screens and glossy photos have different reflection patterns than real skin.
    
    Args:
        image: NumPy array of image
        
    Returns:
        Reflection score (0.0-1.0), higher = more likely live
    """
    try:
        cv2 = _get_cv2()
        if cv2 is None:
            logger.warning("cv2 not available, returning neutral reflection score")
            return 0.5
        # Convert to HSV for better reflection analysis
        if len(image.shape) == 3:
            hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
        else:
            hsv = cv2.cvtColor(cv2.cvtColor(image, cv2.COLOR_GRAY2RGB), cv2.COLOR_RGB2HSV)
        
        # Analyze saturation (screens often have lower saturation)
        saturation = hsv[:, :, 1]
        saturation_mean = np.mean(saturation)
        
        # Real skin has moderate saturation
        # Screens/photos may have very high or very low saturation
        # Normalize to 0-1 (optimal around 0.5)
        saturation_score = 1.0 - abs(saturation_mean - 127.5) / 127.5
        
        # Analyze value (brightness) consistency
        value = hsv[:, :, 2]
        value_std = np.std(value)
        
        # Real faces have natural brightness variation
        # Screens often have uniform brightness or reflections
        brightness_variance_score = min(1.0, value_std / 50.0)
        
        # Combined reflection score
        reflection_score = (saturation_score * 0.6 + brightness_variance_score * 0.4)
        
        return float(reflection_score)
        
    except Exception as e:
        logger.warning(f"Reflection analysis failed: {str(e)}")
        return 0.5  # Neutral score on error


def detect_spoof_type(image: np.ndarray, texture_score: float, depth_score: float) -> Optional[str]:
    """
    Detect the type of spoof attack.
    
    Args:
        image: NumPy array of image
        texture_score: Texture analysis score
        depth_score: Depth analysis score
        
    Returns:
        Spoof type: "photo", "screen", "mask", "deepfake", or None
    """
    try:
        # Very low texture and depth = printed photo
        if texture_score < 0.3 and depth_score < 0.3:
            return "photo"
        
        # Low depth but some texture = screen display
        if depth_score < 0.3 and texture_score > 0.4:
            return "screen"
        
        # Analyze for mask (partial face occlusion)
        # This is a simplified check - real implementation would use face landmarks
        cv2 = _get_cv2()
        if cv2 is None:
            logger.warning("cv2 not available, defaulting to 'photo' spoof type")
            return "photo"
        gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY) if len(image.shape) == 3 else image
        face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        faces = face_cascade.detectMultiScale(gray, 1.1, 4)
        
        if len(faces) == 0:
            # No face detected might indicate mask or deepfake
            return "mask"
        
        # Deepfake detection would require more sophisticated ML models
        # For now, we'll classify unclear cases as potential deepfakes
        if texture_score < 0.4 and depth_score < 0.4:
            return "deepfake"
        
        return "photo"  # Default to photo spoof
        
    except Exception as e:
        logger.warning(f"Spoof type detection failed: {str(e)}")
        return "photo"  # Default


def detect_blinks(video_path: str) -> bool:
    """
    Detect blinks in video for liveness verification.
    This is a placeholder - would require video processing.
    
    Args:
        video_path: Path to video file
        
    Returns:
        True if blinks detected, False otherwise
    """
    # TODO: Implement blink detection using OpenCV video processing
    # This would involve:
    # 1. Extract frames from video
    # 2. Detect face landmarks in each frame
    # 3. Track eye aspect ratio over time
    # 4. Detect blink patterns
    
    logger.info("Blink detection not yet implemented for videos")
    return False


def calculate_quality_score(image: Image.Image) -> float:
    """
    Calculate image quality score for liveness detection.
    
    Args:
        image: PIL Image object
        
    Returns:
        Quality score (0.0-1.0)
    """
    try:
        img_array = preprocess_image(image, enhance=False)
        return calculate_image_quality(img_array)
    except Exception as e:
        logger.error(f"Quality score calculation failed: {str(e)}")
        return 0.0


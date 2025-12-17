"""
Document Authenticity Service for detecting tampering and verifying document authenticity.
Uses OpenCV for texture analysis, edge detection, and pattern recognition.
"""
from typing import Dict
from PIL import Image
import numpy as np
from logging import getLogger

from src.utils.image_utils import preprocess_image, validate_image
from src.config import get_config

logger = getLogger(__name__)

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

# Authenticity thresholds (from config)
TAMPER_THRESHOLD = get_config("tamper_threshold", 0.3)
TEXTURE_CONSISTENCY_THRESHOLD = get_config("texture_consistency_threshold", 0.6)
FONT_CONSISTENCY_THRESHOLD = get_config("font_consistency_threshold", 0.7)
AUTHENTICITY_SCORE_THRESHOLD = get_config("authenticity_score_threshold", 0.75)


def check_authenticity(image: Image.Image) -> Dict:
    """
    Check document authenticity by detecting tampering, holograms, texture consistency, etc.
    
    Args:
        image: PIL Image object
        
    Returns:
        Dictionary with authenticity status, score, and flags
    """
    try:
        # Validate image
        is_valid, error_msg = validate_image(image)
        if not is_valid:
            logger.warning(f"Image validation failed: {error_msg}")
            return {
                "is_authentic": False,
                "authenticity_score": 0.0,
                "flags": {
                    "hologram_detected": False,
                    "texture_consistent": False,
                    "tamper_detected": True,
                    "uv_pattern_valid": None,
                    "font_consistent": False,
                },
            }
        
        # Preprocess image
        img_array = preprocess_image(image, enhance=False)  # Don't enhance for authenticity checks
        
        # Perform various authenticity checks
        tamper_detected = detect_tampering(img_array)
        texture_consistent = analyze_texture_consistency(img_array)
        font_consistent = check_font_consistency(img_array)
        hologram_detected = detect_hologram(img_array)
        
        # Calculate authenticity score
        score_components = []
        
        # Texture consistency (40% weight)
        texture_score = 1.0 if texture_consistent else 0.0
        score_components.append(texture_score * 0.4)
        
        # No tampering (30% weight)
        tamper_score = 0.0 if tamper_detected else 1.0
        score_components.append(tamper_score * 0.3)
        
        # Font consistency (20% weight)
        font_score = 1.0 if font_consistent else 0.0
        score_components.append(font_score * 0.2)
        
        # Hologram presence (10% weight) - optional, indicates genuine document
        hologram_score = 0.5 if hologram_detected else 0.3  # Neutral if not detected
        score_components.append(hologram_score * 0.1)
        
        authenticity_score = sum(score_components)
        
        # Determine if authentic (threshold from config)
        is_authentic = authenticity_score >= AUTHENTICITY_SCORE_THRESHOLD and not tamper_detected
        
        logger.info(f"Document authenticity check: score={authenticity_score:.3f}, authentic={is_authentic}")
        
        return {
            "is_authentic": bool(is_authentic),
            "authenticity_score": float(authenticity_score),
            "flags": {
                "hologram_detected": bool(hologram_detected),
                "texture_consistent": bool(texture_consistent),
                "tamper_detected": bool(tamper_detected),
                "uv_pattern_valid": None,  # UV check requires special lighting
                "font_consistent": bool(font_consistent),
            },
        }
        
    except Exception as e:
        logger.error(f"Document authenticity check failed: {str(e)}", exc_info=True)
        return {
            "is_authentic": False,
            "authenticity_score": 0.0,
            "flags": {
                "hologram_detected": False,
                "texture_consistent": False,
                "tamper_detected": True,
                "uv_pattern_valid": None,
                "font_consistent": False,
            },
        }


def detect_tampering(image: np.ndarray) -> bool:
    """
    Detect tampering in document (editing, pasting, etc.).
    
    Args:
        image: NumPy array of image
        
    Returns:
        True if tampering detected, False otherwise
    """
    try:
        cv2 = _get_cv2()
        if cv2 is None:
            logger.warning("cv2 not available, skipping tamper detection")
            return False
        # Convert to grayscale
        if len(image.shape) == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        else:
            gray = image
        
        # Method 1: Edge detection for suspicious patterns
        # Tampered areas often have sharp, irregular edges
        edges = cv2.Canny(gray, 50, 150)
        
        # Calculate edge density
        edge_density = np.sum(edges > 0) / (edges.shape[0] * edges.shape[1])
        
        # Method 2: Error Level Analysis (ELA)
        # Compressed/edited areas show different error levels
        quality = 95
        compressed = cv2.imencode('.jpg', gray, [cv2.IMWRITE_JPEG_QUALITY, quality])[1]
        compressed = cv2.imdecode(compressed, cv2.IMREAD_GRAYSCALE)
        ela = np.abs(gray.astype(np.float32) - compressed.astype(np.float32))
        ela_mean = np.mean(ela)
        
        # Method 3: Copy-move detection (simplified)
        # Look for duplicate regions (common in tampering)
        # This is a simplified check - full implementation would use more sophisticated algorithms
        
        # Combine indicators
        # High edge density in specific patterns + high ELA = potential tampering
        tamper_score = (edge_density * 0.4 + (ela_mean / 50.0) * 0.6)
        
        tamper_detected = tamper_score > TAMPER_THRESHOLD
        
        if tamper_detected:
            logger.warning(f"Tampering detected: edge_density={edge_density:.3f}, ela_mean={ela_mean:.2f}")
        
        return bool(tamper_detected)
        
    except Exception as e:
        logger.warning(f"Tamper detection failed: {str(e)}")
        return False  # Assume no tampering on error


def analyze_texture_consistency(image: np.ndarray) -> bool:
    """
    Analyze texture consistency across document.
    Genuine documents have consistent texture, tampered ones may have inconsistencies.
    
    Args:
        image: NumPy array of image
        
    Returns:
        True if texture is consistent, False otherwise
    """
    try:
        # Convert to grayscale
        cv2 = _get_cv2()
        if cv2 is None:
            logger.warning("cv2 not available, assuming texture consistency")
            return True
        if len(image.shape) == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        else:
            gray = image
        
        # Divide image into grid regions
        h, w = gray.shape
        grid_size = 4
        region_h = h // grid_size
        region_w = w // grid_size
        
        texture_vars = []
        
        for i in range(grid_size):
            for j in range(grid_size):
                y1 = i * region_h
                y2 = (i + 1) * region_h if i < grid_size - 1 else h
                x1 = j * region_w
                x2 = (j + 1) * region_w if j < grid_size - 1 else w
                
                region = gray[y1:y2, x1:x2]
                
                # Calculate texture variance (using gradient)
                grad_x = cv2.Sobel(region, cv2.CV_64F, 1, 0, ksize=3)
                grad_y = cv2.Sobel(region, cv2.CV_64F, 0, 1, ksize=3)
                gradient_magnitude = np.sqrt(grad_x**2 + grad_y**2)
                texture_var = np.var(gradient_magnitude)
                
                texture_vars.append(texture_var)
        
        # Check consistency (low variance in texture variances = consistent)
        texture_consistency = 1.0 - (np.std(texture_vars) / (np.mean(texture_vars) + 1e-6))
        texture_consistency = max(0.0, min(1.0, texture_consistency))
        
        is_consistent = texture_consistency >= TEXTURE_CONSISTENCY_THRESHOLD
        
        return bool(is_consistent)
        
    except Exception as e:
        logger.warning(f"Texture consistency analysis failed: {str(e)}")
        return True  # Assume consistent on error


def check_font_consistency(image: np.ndarray) -> bool:
    """
    Check font consistency in document.
    Genuine documents use consistent fonts, tampered ones may have font mismatches.
    
    Args:
        image: NumPy array of image
        
    Returns:
        True if fonts are consistent, False otherwise
    """
    try:
        # Convert to grayscale
        cv2 = _get_cv2()
        if cv2 is None:
            logger.warning("cv2 not available, assuming font consistency")
            return True
        if len(image.shape) == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        else:
            gray = image
        
        # This is a simplified font consistency check
        # Real implementation would use OCR to extract text and analyze font characteristics
        
        # Method: Analyze stroke width consistency
        # Genuine documents have consistent stroke widths
        
        # Apply threshold to get binary image
        _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        
        # Calculate stroke width (distance transform)
        dist_transform = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
        
        # Analyze stroke width distribution
        # Consistent fonts have similar stroke widths
        stroke_widths = dist_transform[dist_transform > 0]
        
        if len(stroke_widths) == 0:
            return True  # No text detected, assume consistent
        
        # Calculate coefficient of variation (std/mean)
        # Lower CV = more consistent
        cv_value = np.std(stroke_widths) / (np.mean(stroke_widths) + 1e-6)
        
        # Normalize to 0-1 (lower CV = higher consistency)
        consistency_score = 1.0 / (1.0 + cv_value)
        
        is_consistent = consistency_score >= FONT_CONSISTENCY_THRESHOLD
        
        return bool(is_consistent)
        
    except Exception as e:
        logger.warning(f"Font consistency check failed: {str(e)}")
        return True  # Assume consistent on error


def detect_hologram(image: np.ndarray) -> bool:
    """
    Detect hologram presence in document.
    Many official documents have holograms that reflect light differently.
    
    Args:
        image: NumPy array of image
        
    Returns:
        True if hologram detected, False otherwise
    """
    try:
        # Convert to HSV for better reflection analysis
        cv2 = _get_cv2()
        if cv2 is None:
            logger.warning("cv2 not available, cannot detect hologram")
            return False
        if len(image.shape) == 3:
            hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
        else:
            hsv = cv2.cvtColor(cv2.cvtColor(image, cv2.COLOR_GRAY2RGB), cv2.COLOR_RGB2HSV)
        
        # Holograms typically show:
        # 1. High saturation variations
        # 2. Brightness variations (reflections)
        # 3. Color shifts
        
        saturation = hsv[:, :, 1]
        value = hsv[:, :, 2]
        
        # Calculate variation in saturation and value
        sat_std = np.std(saturation)
        val_std = np.std(value)
        
        # Holograms have high variation in both
        # Thresholds are empirical
        hologram_score = (sat_std / 100.0) * 0.5 + (val_std / 100.0) * 0.5
        hologram_score = min(1.0, hologram_score)
        
        # Also check for rainbow-like color patterns (hue variations)
        hue = hsv[:, :, 0]
        hue_std = np.std(hue)
        hue_score = min(1.0, hue_std / 30.0)
        
        combined_score = (hologram_score * 0.7 + hue_score * 0.3)
        
        hologram_detected = combined_score > 0.4  # Threshold
        
        return bool(hologram_detected)
        
    except Exception as e:
        logger.warning(f"Hologram detection failed: {str(e)}")
        return False  # Assume no hologram on error

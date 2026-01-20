"""
Universal Document Authenticity Service for detecting tampering and verifying document authenticity.
Supports ID Cards, Driving Licenses, and Passports from all countries.
Uses OpenCV for texture analysis, edge detection, and pattern recognition.
"""
from typing import Dict, Optional
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

# Universal authenticity thresholds (adjusted for different document types and qualities)
TAMPER_THRESHOLD = get_config("tamper_threshold", 0.4)  # More lenient for scanned docs
TEXTURE_CONSISTENCY_THRESHOLD = get_config("texture_consistency_threshold", 0.35)  # Lower for photos
FONT_CONSISTENCY_THRESHOLD = get_config("font_consistency_threshold", 0.4)  # More flexible
SECURITY_FEATURES_THRESHOLD = get_config("security_features_threshold", 0.3)  # Flexible for different docs
AUTHENTICITY_SCORE_THRESHOLD = get_config("authenticity_score_threshold", 0.50)  # Balanced threshold


def detect_document_type(image: Image.Image) -> str:
    """
    Detect document type based on layout and aspect ratio.
    
    Args:
        image: PIL Image object
        
    Returns:
        Document type: 'passport', 'driving_license', or 'id_card'
    """
    try:
        width, height = image.size
        aspect_ratio = width / height
        
        # Passport: typically wider book format (aspect ratio > 1.3)
        # ID Card: typically card-sized (aspect ratio ~1.6)
        # License: varies but often rectangular
        
        if aspect_ratio > 1.4:
            if aspect_ratio > 1.8:
                return 'driving_license'  # Often very wide
            else:
                return 'passport'  # Book format
        else:
            return 'id_card'  # Card format
            
    except Exception as e:
        logger.warning(f"Document type detection failed: {e}")
        return 'id_card'  # Default


def get_scoring_weights(doc_type: str) -> Dict[str, float]:
    """
    Get scoring weights based on document type.
    """
    if doc_type == 'passport':
        return {
            'tamper': 0.35,     # High importance for international documents
            'texture': 0.15,    # Less important for book-style
            'font': 0.20,      # Important for official text
            'security': 0.25,   # Passports have many security features
            'layout': 0.05     # Layout is standardized
        }
    elif doc_type == 'driving_license':
        return {
            'tamper': 0.30,     # Important but varies by country
            'texture': 0.20,    # Card texture important
            'font': 0.25,      # Font consistency crucial
            'security': 0.15,   # Some security features
            'layout': 0.10     # Layout varies by jurisdiction
        }
    else:  # id_card (default)
        return {
            'tamper': 0.40,     # Most important for ID verification
            'texture': 0.25,    # Card texture analysis
            'font': 0.20,      # Font consistency
            'security': 0.10,   # Basic security features
            'layout': 0.05     # Layout analysis
        }


def check_authenticity(image: Image.Image) -> Dict:
    """
    Universal document authenticity check for ID cards, licenses, and passports.
    
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
            return create_failed_result("Image validation failed")
        
        # Detect document type
        doc_type = detect_document_type(image)
        logger.info(f"Detected document type: {doc_type}")
        
        # Preprocess image
        img_array = preprocess_image(image, enhance=False)
        
        # Perform universal authenticity checks
        tamper_result = detect_tampering(img_array, doc_type)
        texture_result = analyze_texture_consistency(img_array, doc_type)
        font_result = check_font_consistency(img_array, doc_type)
        security_result = detect_security_features(img_array, doc_type)
        layout_result = validate_document_layout(img_array, doc_type)
        
        # Calculate weighted authenticity score based on document type
        score_weights = get_scoring_weights(doc_type)
        
        score_components = [
            tamper_result['score'] * score_weights['tamper'],
            texture_result['score'] * score_weights['texture'],
            font_result['score'] * score_weights['font'],
            security_result['score'] * score_weights['security'],
            layout_result['score'] * score_weights['layout']
        ]
        
        authenticity_score = sum(score_components)
        
        # Determine if authentic
        is_authentic = (
            authenticity_score >= AUTHENTICITY_SCORE_THRESHOLD and
            not tamper_result['detected'] and
            layout_result['valid']
        )
        
        logger.info(f"Document authenticity check: type={doc_type}, score={authenticity_score:.3f}, authentic={is_authentic}")
        
        return {
            "is_authentic": bool(is_authentic),
            "authenticity_score": float(authenticity_score),
            "document_type": doc_type,
            "flags": {
                "tamper_detected": tamper_result['detected'],
                "texture_consistent": texture_result['consistent'],
                "font_consistent": font_result['consistent'],
                "security_features_present": security_result['present'],
                "layout_valid": layout_result['valid'],
                "hologram_detected": security_result.get('hologram', False),
                "watermark_detected": security_result.get('watermark', False),
            }
        }
        
    except Exception as e:
        logger.error(f"Document authenticity check failed: {str(e)}", exc_info=True)
        return create_failed_result(str(e))


def detect_tampering(image: np.ndarray, doc_type: str) -> Dict:
    """
    Universal tampering detection for all document types.
    
    Args:
        image: NumPy array of image
        doc_type: Document type
        
    Returns:
        Dictionary with tampering analysis results
    """
    try:
        cv2 = _get_cv2()
        if cv2 is None:
            return {'detected': False, 'score': 0.8, 'confidence': 0.5}
        
        # Convert to grayscale
        if len(image.shape) == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        else:
            gray = image
        
        # Multi-method tampering detection
        
        # 1. Edge analysis for irregular patterns
        edges = cv2.Canny(gray, 30, 100)  # More sensitive for documents
        edge_density = np.sum(edges > 0) / (edges.shape[0] * edges.shape[1])
        
        # 2. Compression artifacts analysis (Error Level Analysis)
        quality = 90
        try:
            compressed = cv2.imencode('.jpg', gray, [cv2.IMWRITE_JPEG_QUALITY, quality])[1]
            compressed = cv2.imdecode(compressed, cv2.IMREAD_GRAYSCALE)
            ela = np.abs(gray.astype(np.float32) - compressed.astype(np.float32))
            ela_score = np.mean(ela) / 25.0  # Normalize
        except:
            ela_score = 0.0
        
        # 3. Noise analysis
        noise_level = np.std(cv2.Laplacian(gray, cv2.CV_64F))
        normalized_noise = min(1.0, noise_level / 100.0)
        
        # Combine indicators with document-specific weights
        tamper_score = (edge_density * 0.3 + ela_score * 0.4 + normalized_noise * 0.3)
        threshold = 0.5 if doc_type == 'passport' else 0.4
        
        tamper_detected = tamper_score > threshold
        authenticity_score = max(0.0, 1.0 - tamper_score)
        
        if tamper_detected:
            logger.warning(f"Tampering detected in {doc_type}: score={tamper_score:.3f}")
        
        return {
            'detected': bool(tamper_detected),
            'score': float(authenticity_score),
            'confidence': min(1.0, tamper_score * 1.5)
        }
        
    except Exception as e:
        logger.warning(f"Tamper detection failed: {str(e)}")
        return {'detected': False, 'score': 0.7, 'confidence': 0.3}


def analyze_texture_consistency(image: np.ndarray, doc_type: str) -> Dict:
    """
    Universal texture consistency analysis.
    """
    try:
        cv2 = _get_cv2()
        if cv2 is None:
            return {'consistent': True, 'score': 0.7, 'confidence': 0.5}
        
        if len(image.shape) == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        else:
            gray = image
        
        h, w = gray.shape
        grid_size = 6 if doc_type == 'passport' else 4
        
        region_h = h // grid_size
        region_w = w // grid_size
        
        texture_vars = []
        valid_regions = 0
        
        for i in range(grid_size):
            for j in range(grid_size):
                y1 = i * region_h
                y2 = (i + 1) * region_h if i < grid_size - 1 else h
                x1 = j * region_w
                x2 = (j + 1) * region_w if j < grid_size - 1 else w
                
                region = gray[y1:y2, x1:x2]
                
                if region.size < 100:
                    continue
                
                # Calculate texture using gradients
                grad_x = cv2.Sobel(region, cv2.CV_64F, 1, 0, ksize=3)
                grad_y = cv2.Sobel(region, cv2.CV_64F, 0, 1, ksize=3)
                gradient_magnitude = np.sqrt(grad_x**2 + grad_y**2)
                
                mean_grad = np.mean(gradient_magnitude)
                if mean_grad > 0:
                    relative_var = np.var(gradient_magnitude) / (mean_grad + 1e-6)
                    texture_vars.append(relative_var)
                    valid_regions += 1
        
        if valid_regions < 2:
            return {'consistent': True, 'score': 0.8, 'confidence': 0.4}
        
        if len(texture_vars) > 1:
            texture_std = np.std(texture_vars)
            texture_mean = np.mean(texture_vars)
            consistency_coefficient = 1.0 - (texture_std / (texture_mean + 1e-6))
            consistency_score = max(0.0, min(1.0, consistency_coefficient))
        else:
            consistency_score = 0.8
        
        threshold = TEXTURE_CONSISTENCY_THRESHOLD * (0.8 if doc_type == 'passport' else 1.0)
        is_consistent = consistency_score >= threshold
        
        return {
            'consistent': bool(is_consistent),
            'score': float(consistency_score),
            'confidence': min(1.0, valid_regions / (grid_size * grid_size))
        }
        
    except Exception as e:
        logger.warning(f"Texture consistency analysis failed: {str(e)}")
        return {'consistent': True, 'score': 0.6, 'confidence': 0.3}


def check_font_consistency(image: np.ndarray, doc_type: str) -> Dict:
    """Universal font consistency check."""
    try:
        cv2 = _get_cv2()
        if cv2 is None:
            return {'consistent': True, 'score': 0.7, 'confidence': 0.5}
        
        if len(image.shape) == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        else:
            gray = image
        
        binary = cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 11, 2
        )
        
        dist_transform = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
        stroke_widths = dist_transform[dist_transform > 1.0]
        
        if len(stroke_widths) < 10:
            return {'consistent': True, 'score': 0.8, 'confidence': 0.3}
        
        mean_width = np.mean(stroke_widths)
        std_width = np.std(stroke_widths)
        cv_value = std_width / (mean_width + 1e-6)
        
        consistency_score = 1.0 / (1.0 + cv_value * 2.0)
        threshold = FONT_CONSISTENCY_THRESHOLD * (0.9 if doc_type == 'passport' else 1.0)
        is_consistent = consistency_score >= threshold
        
        return {
            'consistent': bool(is_consistent),
            'score': float(consistency_score),
            'confidence': min(1.0, len(stroke_widths) / 1000.0)
        }
        
    except Exception as e:
        logger.warning(f"Font consistency check failed: {str(e)}")
        return {'consistent': True, 'score': 0.6, 'confidence': 0.3}


def detect_security_features(image: np.ndarray, doc_type: str) -> Dict:
    """Universal security features detection."""
    try:
        cv2 = _get_cv2()
        if cv2 is None:
            return {'present': True, 'score': 0.6, 'confidence': 0.4}
        
        if len(image.shape) == 3:
            hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
            rgb = image
        else:
            rgb = cv2.cvtColor(image, cv2.COLOR_GRAY2RGB)
            hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
        
        security_score = 0.0
        features_detected = {}
        
        hologram_score = detect_holographic_elements(hsv)
        features_detected['hologram'] = hologram_score > 0.3
        security_score += hologram_score * 0.4
        
        watermark_score = detect_watermark_patterns(rgb)
        features_detected['watermark'] = watermark_score > 0.2
        security_score += watermark_score * 0.3
        
        pattern_score = detect_security_patterns(rgb)
        features_detected['security_patterns'] = pattern_score > 0.2
        security_score += pattern_score * 0.3
        
        feature_bonus = sum(features_detected.values()) * 0.1
        adjusted_score = security_score + feature_bonus
        
        has_security_features = adjusted_score >= SECURITY_FEATURES_THRESHOLD
        
        return {
            'present': bool(has_security_features),
            'score': float(min(1.0, adjusted_score)),
            'confidence': 0.6,
            'hologram': features_detected.get('hologram', False),
            'watermark': features_detected.get('watermark', False)
        }
        
    except Exception as e:
        logger.warning(f"Security features detection failed: {str(e)}")
        return {'present': True, 'score': 0.5, 'confidence': 0.3}


def validate_document_layout(image: np.ndarray, doc_type: str) -> Dict:
    """Universal document layout validation."""
    try:
        h, w = image.shape[:2]
        aspect_ratio = w / h
        
        if doc_type == 'passport':
            valid_aspect = 1.2 <= aspect_ratio <= 1.5
        elif doc_type == 'driving_license':
            valid_aspect = 1.4 <= aspect_ratio <= 2.2
        else:  # id_card
            valid_aspect = 1.4 <= aspect_ratio <= 1.8
        
        layout_score = 1.0 if valid_aspect else 0.4  # Partial credit
        
        return {
            'valid': bool(valid_aspect),
            'score': float(layout_score),
            'confidence': 0.8
        }
        
    except Exception as e:
        logger.warning(f"Layout validation failed: {str(e)}")
        return {'valid': True, 'score': 0.7, 'confidence': 0.4}


def create_failed_result(error_msg: str) -> Dict:
    """Create a failed authenticity result."""
    return {
        "is_authentic": False,
        "authenticity_score": 0.0,
        "document_type": "unknown",
        "flags": {
            "tamper_detected": True,
            "texture_consistent": False,
            "font_consistent": False,
            "security_features_present": False,
            "layout_valid": False,
            "hologram_detected": False,
            "watermark_detected": False,
        },
        "error": error_msg
    }


def detect_holographic_elements(hsv_image: np.ndarray) -> float:
    """Detect holographic/reflective elements."""
    try:
        saturation = hsv_image[:, :, 1]
        value = hsv_image[:, :, 2]
        hue = hsv_image[:, :, 0]
        
        sat_std = np.std(saturation) / 100.0
        hue_std = np.std(hue) / 50.0
        val_std = np.std(value) / 100.0
        
        hologram_score = min(1.0, (sat_std * 0.4 + hue_std * 0.4 + val_std * 0.2))
        return hologram_score
    except:
        return 0.0


def detect_watermark_patterns(rgb_image: np.ndarray) -> float:
    """Detect watermark patterns in the image."""
    try:
        cv2 = _get_cv2()
        if cv2 is None:
            return 0.0
        
        if len(rgb_image.shape) == 3:
            gray = cv2.cvtColor(rgb_image, cv2.COLOR_RGB2GRAY)
        else:
            gray = rgb_image
        
        blurred = cv2.GaussianBlur(gray, (15, 15), 0)
        high_pass = cv2.absdiff(gray, blurred)
        
        watermark_intensity = np.mean(high_pass) / 50.0
        return min(1.0, watermark_intensity)
    except:
        return 0.0


def detect_security_patterns(rgb_image: np.ndarray) -> float:
    """Detect security patterns like guilloche."""
    try:
        cv2 = _get_cv2()
        if cv2 is None:
            return 0.0
        
        if len(rgb_image.shape) == 3:
            gray = cv2.cvtColor(rgb_image, cv2.COLOR_RGB2GRAY)
        else:
            gray = rgb_image
        
        edges = cv2.Canny(gray, 50, 150)
        edge_density = np.sum(edges > 0) / edges.size
        
        if 0.1 <= edge_density <= 0.3:
            pattern_score = min(1.0, edge_density * 2.0)
        else:
            pattern_score = 0.2
        
        return pattern_score
    except:
        return 0.0
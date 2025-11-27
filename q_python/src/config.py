"""
Configuration settings for KYC ML services.
"""
import os
from typing import Dict, Any

# ML Model Configuration
ML_CONFIG: Dict[str, Any] = {
    # DeepFace configuration
    "deepface_model": os.getenv("DEEPFACE_MODEL", "VGG-Face"),  # VGG-Face, Facenet, OpenFace, DeepFace, ArcFace
    "deepface_backend": os.getenv("DEEPFACE_BACKEND", "opencv"),  # opencv, ssd, dlib, mtcnn, retinaface
    
    # OCR configuration
    "ocr_languages": ["en"],  # EasyOCR languages
    "ocr_gpu": os.getenv("OCR_GPU", "false").lower() == "true",
    
    # Face matching thresholds
    "face_match_threshold": float(os.getenv("FACE_MATCH_THRESHOLD", "0.6")),
    
    # Liveness detection thresholds
    "liveness_confidence_threshold": float(os.getenv("LIVENESS_CONFIDENCE_THRESHOLD", "0.7")),
    "quality_threshold": float(os.getenv("QUALITY_THRESHOLD", "0.5")),
    
    # Document authenticity thresholds
    "tamper_threshold": float(os.getenv("TAMPER_THRESHOLD", "0.3")),
    "texture_consistency_threshold": float(os.getenv("TEXTURE_CONSISTENCY_THRESHOLD", "0.6")),
    "font_consistency_threshold": float(os.getenv("FONT_CONSISTENCY_THRESHOLD", "0.7")),
    "authenticity_score_threshold": float(os.getenv("AUTHENTICITY_SCORE_THRESHOLD", "0.75")),
    
    # Image processing settings
    "max_image_width": int(os.getenv("MAX_IMAGE_WIDTH", "4000")),
    "max_image_height": int(os.getenv("MAX_IMAGE_HEIGHT", "4000")),
    "min_image_width": int(os.getenv("MIN_IMAGE_WIDTH", "100")),
    "min_image_height": int(os.getenv("MIN_IMAGE_HEIGHT", "100")),
    "allowed_formats": {"JPEG", "PNG", "WEBP", "BMP"},
    
    # Processing timeouts (seconds)
    "ocr_timeout": int(os.getenv("OCR_TIMEOUT", "30")),
    "face_matching_timeout": int(os.getenv("FACE_MATCHING_TIMEOUT", "20")),
    "liveness_timeout": int(os.getenv("LIVENESS_TIMEOUT", "15")),
    "authenticity_timeout": int(os.getenv("AUTHENTICITY_TIMEOUT", "20")),
}

def get_config(key: str, default: Any = None) -> Any:
    """Get configuration value."""
    return ML_CONFIG.get(key, default)

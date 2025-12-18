"""
Configuration settings for KYC ML services and FinBERT model.
"""
import os
from typing import Dict, Any

# Load .env file if it exists
try:
    from dotenv import load_dotenv
    import pathlib
    
    # Try multiple .env file locations
    # 1. q_python/.env (project root)
    env_path1 = os.path.join(os.path.dirname(__file__), '..', '..', '.env')
    if os.path.exists(env_path1):
        load_dotenv(env_path1)
        print(f"Loaded .env from: {env_path1}")
    
    # 2. Current directory
    env_path2 = os.path.join(os.path.dirname(__file__), '.env')
    if os.path.exists(env_path2):
        load_dotenv(env_path2)
        print(f"Loaded .env from: {env_path2}")
    
    # 3. Try loading from current working directory
    load_dotenv(override=False)  # Don't override if already loaded
    
except ImportError:
    print("Warning: python-dotenv not installed. Environment variables must be set manually.")
except Exception as e:
    print(f"Warning: Error loading .env file: {e}")

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

# FinBERT Model Configuration
FINBERT_CONFIG: Dict[str, Any] = {
    # Model path
    "model_path": os.getenv("FINBERT_MODEL_PATH", "ProsusAI/finbert"),
    
    # Device settings
    "device": os.getenv("FINBERT_DEVICE", "auto"),  # auto, cuda, cpu
    
    # Cache directory
    "cache_dir": os.getenv("FINBERT_CACHE_DIR", os.path.expanduser("~/.cache/huggingface")),
    
    # Inference parameters
    "max_length": int(os.getenv("FINBERT_MAX_LENGTH", "512")),
    "batch_size": int(os.getenv("FINBERT_BATCH_SIZE", "8")),
    
    # Inference timeout (seconds)
    "inference_timeout": int(os.getenv("FINBERT_INFERENCE_TIMEOUT", "30")),
    
    # Memory management
    "enable_auto_unload": os.getenv("FINBERT_ENABLE_AUTO_UNLOAD", "false").lower() == "true",
    "idle_timeout": int(os.getenv("FINBERT_IDLE_TIMEOUT", "3600")),  # Unload after 1 hour of inactivity
}

# API Keys Configuration
STOCK_NEWS_API_KEY = os.getenv("STOCK_NEWS_API_KEY")
LUNARCRUSH_API_KEY = os.getenv("LUNARCRUSH_API_KEY")
COINGECKO_API_KEY = os.getenv("COINGECKO_API_KEY")

# NestJS Backend API Configuration
NESTJS_API_URL = os.getenv("NESTJS_API_URL", "http://localhost:3000")
NESTJS_API_TIMEOUT = int(os.getenv("NESTJS_API_TIMEOUT", "10"))

def get_config(key: str, default: Any = None) -> Any:
    """Get configuration value."""
    return ML_CONFIG.get(key, default)

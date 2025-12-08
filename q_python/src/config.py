"""
Configuration settings for KYC ML services and FinGPT model.
"""
import os
from typing import Dict, Any
import torch

# Load .env file if it exists
try:
    from dotenv import load_dotenv
    # Load .env from project root (q_python directory)
    env_path = os.path.join(os.path.dirname(__file__), '..', '..', '.env')
    if os.path.exists(env_path):
        load_dotenv(env_path)
    # Also try loading from current directory
    load_dotenv()
except ImportError:
    pass  # dotenv not installed, skip

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

# FinGPT Model Configuration
FINGPT_CONFIG: Dict[str, Any] = {
    # Model paths
    # Working configuration for sentiment analysis:
    # Base Model: meta-llama/Llama-2-7b-hf (base, NOT chat version)
    # LoRA Adapter: FinGPT/fingpt-mt_llama2-7b_lora (multi-task model)
    "model_path": os.getenv("FINGPT_MODEL_PATH", "FinGPT/fingpt-mt_llama2-7b_lora"),
    "base_model_path": os.getenv("FINGPT_BASE_MODEL_PATH", "meta-llama/Llama-2-7b-hf"),  # Base model, NOT chat variant
    
    # Device settings
    "device": os.getenv("FINGPT_DEVICE", "cuda"),  # auto, cuda, cpu (changed to cuda for GPU)
    "torch_dtype": torch.float16,  # 16-bit quantization
    
    # Model loading options
    "trust_remote_code": os.getenv("FINGPT_TRUST_REMOTE_CODE", "true").lower() == "true",
    "device_map": os.getenv("FINGPT_DEVICE_MAP", "cuda"),  # auto, cuda, cpu (changed to cuda for GPU)
    
    # Cache directory
    "cache_dir": os.getenv("FINGPT_CACHE_DIR", os.path.expanduser("~/.cache/huggingface")),
    
    # Inference parameters
    "max_sequence_length": int(os.getenv("FINGPT_MAX_SEQUENCE_LENGTH", "512")),
    "max_new_tokens": int(os.getenv("FINGPT_MAX_NEW_TOKENS", "15")),  # Increased to ensure full sentiment words are generated
    "temperature": float(os.getenv("FINGPT_TEMPERATURE", "0.1")),  # Lower for more deterministic output
    "top_p": float(os.getenv("FINGPT_TOP_P", "0.9")),
    "do_sample": os.getenv("FINGPT_DO_SAMPLE", "true").lower() == "true",  # Enable sampling - model may need it to generate
    
    # Model loading timeout (seconds)
    "loading_timeout": int(os.getenv("FINGPT_LOADING_TIMEOUT", "300")),
    
    # Inference timeout (seconds) - prevents hanging requests
    "inference_timeout": int(os.getenv("FINGPT_INFERENCE_TIMEOUT", "30")),
    
    # Memory management
    "enable_auto_unload": os.getenv("FINGPT_ENABLE_AUTO_UNLOAD", "false").lower() == "true",
    "idle_timeout": int(os.getenv("FINGPT_IDLE_TIMEOUT", "3600")),  # Unload after 1 hour of inactivity
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

# NestJS Backend API Configuration
NESTJS_API_URL = os.getenv("NESTJS_API_URL", "http://localhost:3000")
NESTJS_API_TIMEOUT = int(os.getenv("NESTJS_API_TIMEOUT", "10"))

def get_config(key: str, default: Any = None) -> Any:
    """Get configuration value."""
    return ML_CONFIG.get(key, default)

"""
FinGPT Model Package
Provides financial sentiment analysis using FinGPT model.
"""
import os
from .model import FinGPTModel
from .tokenizer import FinGPTTokenizer
from .inference import FinGPTInference

__all__ = [
    'FinGPTModel',
    'FinGPTTokenizer',
    'FinGPTInference',
    'get_fingpt_inference',
]

# Singleton instance for inference
_inference_instance: FinGPTInference = None


def get_fingpt_inference(use_keyword_fallback: bool = None) -> FinGPTInference:
    """
    Factory function to get or create FinGPT inference instance.
    Uses singleton pattern to ensure only one instance exists.
    
    Args:
        use_keyword_fallback: If False, only use model predictions (no keyword fallback).
                              If None, reads from FINGPT_USE_KEYWORD_FALLBACK env var (default True).
    
    Returns:
        FinGPTInference instance
    """
    global _inference_instance
    
    # Determine keyword fallback setting
    if use_keyword_fallback is None:
        env_value = os.getenv("FINGPT_USE_KEYWORD_FALLBACK", "true").lower()
        use_keyword_fallback = env_value in ("true", "1", "yes")
    
    # Create new instance if needed or if settings changed
    if _inference_instance is None:
        _inference_instance = FinGPTInference(use_keyword_fallback=use_keyword_fallback)
    elif hasattr(_inference_instance, 'use_keyword_fallback'):
        if _inference_instance.use_keyword_fallback != use_keyword_fallback:
            # Settings changed, create new instance
            _inference_instance = FinGPTInference(use_keyword_fallback=use_keyword_fallback)
    
    return _inference_instance


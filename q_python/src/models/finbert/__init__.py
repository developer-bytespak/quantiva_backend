"""
FinBERT Model Package
Provides financial sentiment analysis using ProsusAI/finbert model.
"""
import os
from .model import FinBERTModel
from .inference import FinBERTInference

__all__ = [
    'FinBERTModel',
    'FinBERTInference',
    'get_finbert_inference',
]

# Singleton instance for inference
_inference_instance: FinBERTInference = None


def get_finbert_inference() -> FinBERTInference:
    """
    Factory function to get or create FinBERT inference instance.
    Uses singleton pattern to ensure only one instance exists.
    
    Returns:
        FinBERTInference instance
    """
    global _inference_instance
    
    if _inference_instance is None:
        _inference_instance = FinBERTInference()
    
    return _inference_instance


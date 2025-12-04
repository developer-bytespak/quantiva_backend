"""
FinGPT Model Package
Provides financial sentiment analysis using FinGPT model.
"""
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


def get_fingpt_inference() -> FinGPTInference:
    """
    Factory function to get or create FinGPT inference instance.
    Uses singleton pattern to ensure only one instance exists.
    
    Returns:
        FinGPTInference instance
    """
    global _inference_instance
    
    if _inference_instance is None:
        _inference_instance = FinGPTInference()
    
    return _inference_instance


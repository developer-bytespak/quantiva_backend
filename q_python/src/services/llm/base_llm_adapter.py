"""
Base LLM Adapter Interface
Abstract base class for LLM providers (Gemini, OpenAI, etc.)
"""
from abc import ABC, abstractmethod
from typing import Dict, Any


class BaseLLMAdapter(ABC):
    """
    Abstract base class for LLM adapters.
    All LLM providers must implement this interface.
    """
    
    @abstractmethod
    def explain_signal(
        self,
        signal_data: Dict[str, Any],
        engine_scores: Dict[str, Any],
        asset_id: str,
        asset_type: str
    ) -> Dict[str, Any]:
        """
        Generate explanation for a trading signal.
        
        Args:
            signal_data: Signal data including action, final_score, confidence
            engine_scores: Dictionary of all engine scores and metadata
            asset_id: Asset identifier
            asset_type: 'crypto' or 'stock'
        
        Returns:
            Dictionary with:
                - explanation: str - Human-readable explanation
                - model: str - Model name used
                - confidence: float - Confidence in explanation (optional)
        """
        pass


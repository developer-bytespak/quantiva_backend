"""
Signal Explainer Service
Uses LLM adapters to generate human-readable explanations for trading signals.
"""
import os
import logging
from typing import Dict, Any, Optional

from .base_llm_adapter import BaseLLMAdapter
from .gemini_adapter import GeminiAdapter
from .openai_adapter import OpenAIAdapter

logger = logging.getLogger(__name__)


class SignalExplainer:
    """
    Service for generating signal explanations using LLM adapters.
    """
    
    def __init__(self, provider: Optional[str] = None):
        """
        Initialize signal explainer with specified LLM provider.
        
        Args:
            provider: LLM provider name ('gemini' or 'openai'). 
                     If None, uses LLM_PROVIDER env var or defaults to 'gemini'
        """
        self.provider = provider or os.getenv("LLM_PROVIDER", "gemini").lower()
        self.adapter: BaseLLMAdapter = self._create_adapter()
        
        logger.info(f"Initialized SignalExplainer with provider: {self.provider}")
    
    def _create_adapter(self) -> BaseLLMAdapter:
        """Create appropriate LLM adapter based on provider."""
        if self.provider == "gemini":
            try:
                return GeminiAdapter()
            except Exception as e:
                logger.error(f"Failed to initialize Gemini adapter: {str(e)}")
                raise
        elif self.provider == "openai":
            return OpenAIAdapter()
        else:
            logger.warning(
                f"Unknown LLM provider: {self.provider}. Defaulting to Gemini."
            )
            try:
                return GeminiAdapter()
            except Exception as e:
                logger.error(f"Failed to initialize Gemini adapter: {str(e)}")
                raise
    
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
                - confidence: float - Confidence in explanation
        """
        try:
            return self.adapter.explain_signal(
                signal_data=signal_data,
                engine_scores=engine_scores,
                asset_id=asset_id,
                asset_type=asset_type
            )
        except Exception as e:
            logger.error(f"Error generating signal explanation: {str(e)}")
            # Return placeholder explanation on error
            return {
                "explanation": f"Unable to generate explanation: {str(e)}",
                "model": self.provider,
                "confidence": 0.0,
                "error": True
            }

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
            provider: LLM provider name ('openai' or 'gemini'). 
                     If None, uses LLM_PROVIDER env var or defaults to 'openai'
        """
        self.provider = provider or os.getenv("LLM_PROVIDER", "openai").lower()
        self.fallback_provider = "gemini" if self.provider == "openai" else "openai"
        self.adapter: BaseLLMAdapter = self._create_adapter()
        # Lazily-created adapter for per-call fallback (e.g. primary hits its
        # daily quota mid-run). None until first needed; False if it failed
        # to initialize so we don't retry construction on every call.
        self._runtime_fallback: Optional[BaseLLMAdapter] = None

        logger.info(f"Initialized SignalExplainer with provider: {self.provider}, fallback: {self.fallback_provider}")
    
    def _create_adapter(self) -> BaseLLMAdapter:
        """Create appropriate LLM adapter based on provider."""
        if self.provider == "openai":
            try:
                return OpenAIAdapter()
            except Exception as e:
                logger.warning(f"Failed to initialize OpenAI adapter: {str(e)}. Trying fallback...")
                return self._create_fallback_adapter()
        elif self.provider == "gemini":
            try:
                return GeminiAdapter()
            except Exception as e:
                logger.warning(f"Failed to initialize Gemini adapter: {str(e)}. Trying fallback...")
                return self._create_fallback_adapter()
        else:
            logger.warning(
                f"Unknown LLM provider: {self.provider}. Defaulting to OpenAI."
            )
            try:
                return OpenAIAdapter()
            except Exception as e:
                logger.error(f"Failed to initialize OpenAI adapter: {str(e)}")
                return self._create_fallback_adapter()
    
    def _create_fallback_adapter(self) -> BaseLLMAdapter:
        """Create fallback adapter if primary fails."""
        try:
            if self.fallback_provider == "gemini":
                logger.info("Using Gemini as fallback provider")
                return GeminiAdapter()
            else:
                logger.info("Using OpenAI as fallback provider")
                return OpenAIAdapter()
        except Exception as e:
            logger.error(f"Failed to initialize fallback adapter: {str(e)}")
            raise ValueError("All LLM providers failed to initialize")
    
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

        # Primary failed at call time (quota, outage) — try the other
        # provider once before giving up.
        fallback = self._get_runtime_fallback()
        if fallback is not None:
            try:
                return fallback.explain_signal(
                    signal_data=signal_data,
                    engine_scores=engine_scores,
                    asset_id=asset_id,
                    asset_type=asset_type
                )
            except Exception as e:
                logger.error(f"Fallback ({self.fallback_provider}) explanation also failed: {str(e)}")

        return {
            "explanation": "Unable to generate explanation: all LLM providers failed",
            "model": self.provider,
            "confidence": 0.0,
            "error": True
        }

    def _get_runtime_fallback(self) -> Optional[BaseLLMAdapter]:
        """Lazily build the fallback adapter for per-call failover. Returns
        None (and stops trying) if it can't be constructed."""
        if self._runtime_fallback is False:  # construction already failed
            return None
        if self._runtime_fallback is None:
            try:
                if self.fallback_provider == "gemini":
                    self._runtime_fallback = GeminiAdapter()
                else:
                    self._runtime_fallback = OpenAIAdapter()
                logger.info(f"Initialized runtime fallback adapter: {self.fallback_provider}")
            except Exception as e:
                logger.warning(f"Could not initialize runtime fallback ({self.fallback_provider}): {str(e)}")
                self._runtime_fallback = False
                return None
        return self._runtime_fallback

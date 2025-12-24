"""
OpenAI LLM Adapter
Implementation using OpenAI GPT models for signal explanations.
"""
import os
import logging
from typing import Dict, Any

from .base_llm_adapter import BaseLLMAdapter
from .prompt_templates import create_signal_explanation_prompt

# Try importing OpenAI
try:
    from openai import OpenAI
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False
    logger = logging.getLogger(__name__)
    logger.warning("OpenAI package not installed. Run: pip install openai")

logger = logging.getLogger(__name__)


class OpenAIAdapter(BaseLLMAdapter):
    """
    OpenAI LLM adapter using OpenAI SDK.
    Uses GPT-4o-mini for cost-effective signal explanations.
    """
    
    def __init__(self):
        """Initialize OpenAI adapter."""
        if not OPENAI_AVAILABLE:
            raise ImportError(
                "OpenAI package not installed. Install with: pip install openai"
            )
        
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY environment variable not set")
        
        # Initialize OpenAI client
        self.client = OpenAI(api_key=api_key)
        
        # Use gpt-4o-mini (cost-effective, high quality)
        model_name = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        
        # Supported models
        supported_models = [
            "gpt-4o-mini",      # Most cost-effective ($0.15/1M input, $0.60/1M output)
            "gpt-4o",           # Higher quality
            "gpt-4-turbo",      # Legacy turbo
            "gpt-3.5-turbo",    # Older, cheaper
        ]
        
        if model_name not in supported_models:
            logger.warning(
                f"Model {model_name} not in supported list. Using gpt-4o-mini. "
                f"Supported: {supported_models}"
            )
            model_name = "gpt-4o-mini"
        
        self.model = model_name
        logger.info(f"Initialized OpenAI adapter with model: {self.model}")
    
    def explain_signal(
        self,
        signal_data: Dict[str, Any],
        engine_scores: Dict[str, Any],
        asset_id: str,
        asset_type: str
    ) -> Dict[str, Any]:
        """
        Generate explanation using OpenAI GPT.
        
        Args:
            signal_data: Signal data including action, final_score, confidence
            engine_scores: Dictionary of all engine scores and metadata
            asset_id: Asset identifier
            asset_type: 'crypto' or 'stock'
        
        Returns:
            Dictionary with explanation, model, and confidence
        """
        try:
            # Create prompt using template
            prompt = create_signal_explanation_prompt(
                signal_data=signal_data,
                engine_scores=engine_scores,
                asset_id=asset_id,
                asset_type=asset_type
            )
            
            # Call OpenAI API
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a professional crypto/stock trading analyst. Provide clear, actionable trading signal explanations."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                max_tokens=300,
                temperature=0.7,
            )
            
            # Extract explanation
            explanation = response.choices[0].message.content.strip()
            
            # Calculate confidence based on signal confidence
            confidence = signal_data.get("confidence", 0.7)
            
            logger.info(f"Generated OpenAI explanation for {asset_id} ({len(explanation)} chars)")
            
            return {
                "explanation": explanation,
                "model": self.model,
                "confidence": confidence,
                "tokens_used": response.usage.total_tokens if response.usage else None
            }
            
        except Exception as e:
            logger.error(f"Error generating OpenAI explanation: {str(e)}")
            raise


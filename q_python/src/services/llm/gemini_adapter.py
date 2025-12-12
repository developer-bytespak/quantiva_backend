"""
Gemini LLM Adapter
Implementation using Google Gemini 2.5 Flash for signal explanations.
"""
import os
import logging
import time
from typing import Dict, Any, Optional

try:
    import google.generativeai as genai
    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False

from .base_llm_adapter import BaseLLMAdapter

logger = logging.getLogger(__name__)


class GeminiAdapter(BaseLLMAdapter):
    """
    Gemini LLM adapter using Google Generative AI SDK.
    """
    
    def __init__(self):
        """Initialize Gemini adapter."""
        if not GEMINI_AVAILABLE:
            raise ImportError(
                "google-generativeai not installed. Install with: pip install google-generativeai"
            )
        
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise ValueError("GEMINI_API_KEY environment variable not set")
        
        # Configure Gemini
        genai.configure(api_key=api_key)
        
        # Get model name from env or use default
        model_name = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")
        
        try:
            # Try primary model first
            if model_name == "gemini-2.0-flash-exp":
                self.model = genai.GenerativeModel(model_name)
            else:
                # Fallback to gemini-1.5-flash
                self.model = genai.GenerativeModel("gemini-1.5-flash")
                model_name = "gemini-1.5-flash"
        except Exception as e:
            logger.warning(f"Failed to load {model_name}, falling back to gemini-1.5-flash: {e}")
            self.model = genai.GenerativeModel("gemini-1.5-flash")
            model_name = "gemini-1.5-flash"
        
        self.model_name = model_name
        self.temperature = 0.7
        self.max_tokens = 500
        
        logger.info(f"Initialized Gemini adapter with model: {self.model_name}")
    
    def explain_signal(
        self,
        signal_data: Dict[str, Any],
        engine_scores: Dict[str, Any],
        asset_id: str,
        asset_type: str
    ) -> Dict[str, Any]:
        """
        Generate explanation using Gemini.
        
        Args:
            signal_data: Signal data
            engine_scores: Engine scores
            asset_id: Asset identifier
            asset_type: Asset type
        
        Returns:
            Dictionary with explanation, model, and confidence
        """
        try:
            # Build prompt
            prompt = self._build_prompt(signal_data, engine_scores, asset_id, asset_type)
            
            # Generate with retry logic
            explanation = self._generate_with_retry(prompt, max_retries=3)
            
            return {
                "explanation": explanation,
                "model": self.model_name,
                "confidence": 0.8  # Default confidence
            }
        except Exception as e:
            logger.error(f"Error generating Gemini explanation: {str(e)}")
            raise
    
    def _build_prompt(
        self,
        signal_data: Dict[str, Any],
        engine_scores: Dict[str, Any],
        asset_id: str,
        asset_type: str
    ) -> str:
        """Build detailed prompt for signal explanation."""
        action = signal_data.get("action", "HOLD")
        final_score = signal_data.get("final_score", 0.0)
        confidence = signal_data.get("confidence", 0.0)
        
        # Extract engine scores
        sentiment_score = engine_scores.get("sentiment", {}).get("score", 0.0)
        trend_score = engine_scores.get("trend", {}).get("score", 0.0)
        fundamental_score = engine_scores.get("fundamental", {}).get("score", 0.0)
        liquidity_score = engine_scores.get("liquidity", {}).get("score", 0.0)
        event_risk_score = engine_scores.get("event_risk", {}).get("score", 0.0)
        
        prompt = f"""You are a financial trading analyst. Explain the following trading signal in clear, concise language.

Asset: {asset_id} ({asset_type})
Signal: {action}
Final Score: {final_score:.3f}
Confidence: {confidence:.2%}

Engine Scores:
- Sentiment: {sentiment_score:.3f}
- Trend: {trend_score:.3f}
- Fundamental: {fundamental_score:.3f}
- Liquidity: {liquidity_score:.3f}
- Event Risk: {event_risk_score:.3f}

Provide a brief explanation (2-3 sentences) explaining:
1. Why this signal was generated
2. The key factors driving the decision
3. Any important considerations

Keep it professional and easy to understand."""
        
        return prompt
    
    def _generate_with_retry(self, prompt: str, max_retries: int = 3) -> str:
        """Generate explanation with exponential backoff retry."""
        for attempt in range(max_retries):
            try:
                response = self.model.generate_content(
                    prompt,
                    generation_config={
                        "temperature": self.temperature,
                        "max_output_tokens": self.max_tokens,
                    }
                )
                
                if response and response.text:
                    return response.text.strip()
                else:
                    raise ValueError("Empty response from Gemini")
                    
            except Exception as e:
                if attempt < max_retries - 1:
                    wait_time = 2 ** attempt  # Exponential backoff
                    logger.warning(
                        f"Gemini API error (attempt {attempt + 1}/{max_retries}): {str(e)}. "
                        f"Retrying in {wait_time}s..."
                    )
                    time.sleep(wait_time)
                else:
                    logger.error(f"Gemini API failed after {max_retries} attempts: {str(e)}")
                    raise
        
        raise Exception("Failed to generate explanation after retries")


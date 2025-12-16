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
        # Use gemini-2.5-flash (available in free tier) as default
        model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        
        # List of models to try in order (based on what's available in your project)
        models_to_try = [
            model_name,  # User specified or default
            "gemini-2.5-flash",  # Latest flash model (free tier: 5 RPM, 250K TPM, 20 RPD)
            "gemini-2.5-flash-lite",  # Lite version (free tier: 10 RPM, 250K TPM, 20 RPD)
            "gemini-1.5-flash-latest",  # Fallback to older model
            "gemini-1.5-pro",  # Pro model fallback
            "gemini-pro",  # Original pro model fallback
        ]
        
        # Try each model until one works
        last_error = None
        for model_to_try in models_to_try:
            try:
                self.model = genai.GenerativeModel(model_to_try)
                model_name = model_to_try
                logger.info(f"Successfully loaded Gemini model: {model_name}")
                break
            except Exception as e:
                last_error = e
                logger.warning(f"Failed to load {model_to_try}: {str(e)}")
                continue
        
        if not hasattr(self, 'model'):
            raise ValueError(
                f"Could not load any Gemini model. Tried: {', '.join(models_to_try)}. "
                f"Last error: {str(last_error)}"
            )
        
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
        
        # Convert to float if string (from database)
        final_score_raw = signal_data.get("final_score", 0.0)
        confidence_raw = signal_data.get("confidence", 0.0)
        
        try:
            final_score = float(final_score_raw) if final_score_raw is not None else 0.0
        except (ValueError, TypeError):
            final_score = 0.0
        
        try:
            confidence = float(confidence_raw) if confidence_raw is not None else 0.0
        except (ValueError, TypeError):
            confidence = 0.0
        
        # Extract engine scores (ensure they're floats)
        def safe_float(value, default=0.0):
            try:
                if value is None:
                    return default
                return float(value)
            except (ValueError, TypeError):
                return default
        
        sentiment_score = safe_float(engine_scores.get("sentiment", {}).get("score", 0.0))
        trend_score = safe_float(engine_scores.get("trend", {}).get("score", 0.0))
        fundamental_score = safe_float(engine_scores.get("fundamental", {}).get("score", 0.0))
        liquidity_score = safe_float(engine_scores.get("liquidity", {}).get("score", 0.0))
        event_risk_score = safe_float(engine_scores.get("event_risk", {}).get("score", 0.0))
        
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


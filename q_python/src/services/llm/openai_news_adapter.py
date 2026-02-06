"""
OpenAI News Description Adapter
Generates news descriptions for crypto using OpenAI GPT models.
"""
import os
import logging
from typing import Optional

try:
    from openai import OpenAI
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False
    logging.getLogger(__name__).warning("OpenAI package not installed. Run: pip install openai")

logger = logging.getLogger(__name__)

class OpenAINewsAdapter:
    def __init__(self):
        if not OPENAI_AVAILABLE:
            raise ImportError("OpenAI package not installed. Install with: pip install openai")
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY environment variable not set")
        self.client = OpenAI(api_key=api_key)
        self.model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        logger.info(f"Initialized OpenAI news adapter with model: {self.model}")

    def generate_description(self, title: str, symbol: str) -> Optional[str]:
        prompt = f"""Generate a brief, factual news description (1-2 sentences, max 120 characters) for this cryptocurrency news headline.\n\nCryptocurrency: {symbol}\nTitle: {title}\n\nGuidelines:\n- Be concise and professional\n- Avoid speculation\n- Focus on the main news point\n- Return ONLY the description, no other text"""
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "You are a professional crypto news summarizer. Provide clear, concise, factual news descriptions."},
                    {"role": "user", "content": prompt}
                ],
                max_tokens=120,
                temperature=0.5,
            )
            description = response.choices[0].message.content.strip()
            return description[:200] if len(description) > 200 else description
        except Exception as e:
            logger.warning(f"OpenAI failed to generate description for '{title}': {str(e)}")
            return None

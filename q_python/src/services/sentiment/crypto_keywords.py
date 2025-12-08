"""
Crypto Keyword Analyzer
Analyzes crypto-specific slang and terminology for sentiment analysis.
Loads keywords from JSON file with fallback to hardcoded dictionary.
"""
import re
import json
import logging
import os
from pathlib import Path
from typing import Dict, Any, List

logger = logging.getLogger(__name__)


class CryptoKeywordAnalyzer:
    """
    Analyzes crypto-specific keywords in text to determine sentiment.
    Uses static keyword dictionaries with weights.
    """
    
    def __init__(self):
        """Initialize crypto keyword analyzer."""
        self.logger = logging.getLogger(__name__)
        # Load keywords from JSON file, fallback to hardcoded
        self.POSITIVE_KEYWORDS, self.NEGATIVE_KEYWORDS, self.NEUTRAL_KEYWORDS = self._load_keywords()
    
    def _load_keywords(self) -> tuple:
        """
        Load keywords from JSON file.
        JSON file is the primary source for keyword management.
        
        Returns:
            Tuple of (positive_keywords, negative_keywords, neutral_keywords) dictionaries
        
        Raises:
            FileNotFoundError: If JSON file is missing
            ValueError: If JSON file is invalid
        """
        # Load from JSON file (primary source)
        json_path = Path(__file__).parent / 'crypto_keywords.json'
        
        if not json_path.exists():
            raise FileNotFoundError(
                f"Keywords JSON file not found at {json_path}. "
                f"Please ensure crypto_keywords.json exists in the sentiment directory."
            )
        
        try:
            with open(json_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            # Flatten the nested structure
            positive = {}
            if 'positive' in data:
                for category in ['high_weight', 'medium_weight', 'low_weight']:
                    if category in data['positive']:
                        positive.update(data['positive'][category])
            
            negative = {}
            if 'negative' in data:
                for category in ['high_weight', 'medium_weight', 'low_weight']:
                    if category in data['negative']:
                        negative.update(data['negative'][category])
            
            neutral = data.get('neutral', {})
            
            # Validate that we loaded some keywords
            if not positive and not negative and not neutral:
                raise ValueError("JSON file exists but contains no keywords")
            
            self.logger.info(
                f"Loaded keywords from JSON: {len(positive)} positive, "
                f"{len(negative)} negative, {len(neutral)} neutral"
            )
            
            return positive, negative, neutral
            
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON format in crypto_keywords.json: {str(e)}")
        except Exception as e:
            raise RuntimeError(f"Failed to load keywords from JSON: {str(e)}")
    
    def analyze(self, text: str) -> Dict[str, Any]:
        """
        Analyze text for crypto-specific keywords and determine sentiment.
        
        Args:
            text: Input text to analyze
            
        Returns:
            Dictionary with:
                - sentiment: 'positive', 'negative', or 'neutral'
                - score: float in range [-1.0, 1.0]
                - confidence: float in range [0.0, 1.0]
                - matched_keywords: list of matched keywords
        """
        if not text:
            return {
                'sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'matched_keywords': []
            }
        
        text_lower = text.lower()
        matched_keywords = []
        positive_score = 0.0
        negative_score = 0.0
        neutral_score = 0.0
        
        # Check positive keywords
        for keyword, weight in self.POSITIVE_KEYWORDS.items():
            if self._match_keyword(text_lower, keyword):
                matched_keywords.append(keyword)
                positive_score += weight
        
        # Check negative keywords
        for keyword, weight in self.NEGATIVE_KEYWORDS.items():
            if self._match_keyword(text_lower, keyword):
                matched_keywords.append(keyword)
                negative_score += weight
        
        # Check neutral keywords
        for keyword, weight in self.NEUTRAL_KEYWORDS.items():
            if self._match_keyword(text_lower, keyword):
                matched_keywords.append(keyword)
                neutral_score += weight
        
        # Calculate net sentiment score
        total_positive = positive_score
        total_negative = negative_score
        total_neutral = neutral_score
        
        # Normalize to [-1.0, 1.0] range
        # Use max weight as normalization factor (2.0 for high weight keywords)
        max_possible_score = 2.0 * 5  # Assume max 5 high-weight matches
        
        if total_positive > 0 or total_negative > 0:
            # Net score: positive - negative, normalized
            net_score = (total_positive - total_negative) / max(max_possible_score, total_positive + total_negative)
            net_score = max(-1.0, min(1.0, net_score))
        else:
            # Only neutral keywords or no matches
            net_score = 0.0
        
        # Determine sentiment label
        if net_score > 0.1:
            sentiment = 'positive'
        elif net_score < -0.1:
            sentiment = 'negative'
        else:
            sentiment = 'neutral'
        
        # Calculate confidence based on number of matches and total weight
        total_matches = len(matched_keywords)
        total_weight = total_positive + total_negative + total_neutral
        
        if total_matches == 0:
            confidence = 0.0
        elif total_matches == 1:
            confidence = 0.3
        elif total_matches <= 3:
            confidence = min(0.8, 0.3 + (total_weight / 10.0))
        else:
            confidence = min(0.95, 0.5 + (total_weight / 15.0))
        
        return {
            'sentiment': sentiment,
            'score': net_score,
            'confidence': confidence,
            'matched_keywords': matched_keywords,
            'positive_weight': total_positive,
            'negative_weight': total_negative,
            'neutral_weight': total_neutral
        }
    
    def _match_keyword(self, text: str, keyword: str) -> bool:
        """
        Match keyword in text (exact word matching, case-insensitive).
        
        Args:
            text: Lowercase text to search
            keyword: Keyword to find
            
        Returns:
            True if keyword found, False otherwise
        """
        # For multi-word keywords, use exact phrase matching
        if ' ' in keyword:
            return keyword in text
        
        # For single-word keywords, use word boundary matching
        pattern = r'\b' + re.escape(keyword) + r'\b'
        return bool(re.search(pattern, text))


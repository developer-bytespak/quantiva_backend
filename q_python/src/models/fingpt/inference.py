"""
FinGPT Inference Pipeline - FINAL FIXED VERSION
Handles sentiment analysis using the FinGPT model.
"""
import logging
import re
import torch
from typing import List, Dict, Any, Optional, Tuple
from .model import FinGPTModel
from .tokenizer import FinGPTTokenizer
from src.config import FINGPT_CONFIG

logger = logging.getLogger(__name__)


class FinGPTInference:
    """
    Inference class for FinGPT sentiment analysis.
    Handles text preprocessing, prompt formatting, and sentiment classification.
    """
    
    # Simplified prompt for numerical sentiment score
    # Score range: -1 (very negative) to +1 (very positive), 0 (neutral)
    SENTIMENT_PROMPT_TEMPLATE = """What is the sentiment score (-1.0 to 1.0) of this financial news?
{text}
Score:"""
    
    def __init__(self):
        """Initialize inference pipeline with model and tokenizer."""
        self.logger = logging.getLogger(__name__)
        self.model_manager = FinGPTModel()
        self.tokenizer = FinGPTTokenizer()
        self.max_new_tokens = FINGPT_CONFIG.get("max_new_tokens", 10)
        self.temperature = FINGPT_CONFIG.get("temperature", 0.1)
        self.top_p = FINGPT_CONFIG.get("top_p", 0.9)
        self.do_sample = FINGPT_CONFIG.get("do_sample", False)
        self._model = None
    
    def _get_model(self):
        """Get model instance, loading if necessary."""
        if self._model is None:
            self._model = self.model_manager.get_model()
        return self._model
    
    def _create_prompt(self, text: str) -> str:
        """
        Create sentiment analysis prompt from text.
        
        Args:
            text: Input text to analyze
            
        Returns:
            Formatted prompt string
        """
        # Truncate text if too long (keep first 400 chars for safety)
        if len(text) > 400:
            text = text[:400] + "..."
        return self.SENTIMENT_PROMPT_TEMPLATE.format(text=text)
    
    def _parse_sentiment_score(self, output_text: str, full_output: str = "") -> Tuple[float, float]:
        """
        Parse numerical sentiment score from model output.
        
        Args:
            output_text: Cleaned model output text
            full_output: Full generated text for debugging
            
        Returns:
            Tuple of (sentiment_score, confidence)
            sentiment_score: float in range [-1.0, 1.0]
            confidence: float in range [0.0, 1.0]
        """
        if not output_text:
            self.logger.warning(f"Empty output text. Full output: {full_output[:200]}")
            return 0.0, 0.0
        
        # Log the output for debugging
        self.logger.debug(f"Parsing output: '{output_text}'")
        
        # Try to extract a numerical score from the output
        # Look for patterns like: "0.5", "-0.3", "+0.8", "0.75", etc.
        score_patterns = [
            r'[-+]?\d*\.?\d+',  # Match any number (including decimals and signs)
            r'[-+]?\d+',        # Match integers with optional sign
        ]
        
        score = None
        for pattern in score_patterns:
            matches = re.findall(pattern, output_text)
            if matches:
                try:
                    # Try to parse the first number found
                    candidate = float(matches[0])
                    # Clamp to [-1, 1] range
                    if -1.0 <= candidate <= 1.0:
                        score = candidate
                        break
                    # If outside range, normalize it (assume it's on a different scale)
                    elif abs(candidate) > 1.0:
                        # Normalize: if it's like 5, assume it's 5/10 = 0.5
                        score = max(-1.0, min(1.0, candidate / 10.0))
                        break
                except ValueError:
                    continue
        
        # If no score found, try to infer from keywords
        if score is None:
            output_lower = output_text.lower().strip()
            
            # Strong positive indicators
            if any(word in output_lower for word in ['positive', 'bullish', 'surge', 'rally', 'jump', 'gain', 'rise', 'strong', 'good', 'excellent', 'great']):
                score = 0.7
            # Strong negative indicators
            elif any(word in output_lower for word in ['negative', 'bearish', 'crash', 'plummet', 'drop', 'fall', 'decline', 'loss', 'weak', 'bad', 'poor', 'hack', 'breach']):
                score = -0.7
            # Neutral indicators
            elif any(word in output_lower for word in ['neutral', 'stable', 'steady', 'flat', 'unchanged', 'mixed']):
                score = 0.0
            # Default to neutral
            else:
                self.logger.warning(f"Could not parse score from: '{output_text}'")
                score = 0.0
        
        # Calculate confidence based on how clear the score is
        # If we got a direct number, high confidence
        if re.search(r'[-+]?\d*\.?\d+', output_text):
            confidence = 0.9
        # If we inferred from keywords, medium confidence
        elif score != 0.0:
            confidence = 0.6
        # Default neutral, low confidence
        else:
            confidence = 0.3
        
        return score, confidence
    
    def _score_to_sentiment_label(self, score: float) -> str:
        """
        Convert numerical score to sentiment label.
        
        Args:
            score: Sentiment score in range [-1.0, 1.0]
            
        Returns:
            Sentiment label: 'positive', 'negative', or 'neutral'
        """
        if score > 0.2:
            return 'positive'
        elif score < -0.2:
            return 'negative'
        else:
            return 'neutral'
    
    def analyze_sentiment(self, text: str) -> Dict[str, Any]:
        """
        Analyze sentiment using logits-based approach (more reliable than generation).
        
        Args:
            text: Input text to analyze
            
        Returns:
            Dictionary with sentiment analysis results
        """
        if not text or not isinstance(text, str):
            self.logger.warning("Empty or invalid text provided")
            return {
                'sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'raw_output': ''
            }
        
        try:
            # First, try keyword-based analysis for clear cases
            keyword_result = self._fallback_keyword_analysis(text)
            
            # Create prompt - FinGPT format
            prompt = f"Instruction: What is the sentiment of this financial news? Please choose an answer from [negative/neutral/positive].\nInput: {text}\nAnswer:"
            
            # Tokenize
            inputs = self.tokenizer.tokenize(
                prompt,
                padding=True,
                truncation=True,
                max_length=512,
                return_tensors="pt"
            )
            
            # Move to device
            device = self.model_manager.device
            if device == "cuda" and torch.cuda.is_available():
                device = "cuda:0"
                inputs = {k: v.to(device) for k, v in inputs.items()}
            elif device == "cuda":
                if torch.cuda.is_available():
                    device = "cuda:0"
                    inputs = {k: v.to(device) for k, v in inputs.items()}
                else:
                    self.logger.warning("CUDA requested but not available, using CPU")
                    device = "cpu"
            
            # Get model
            model = self._get_model()
            
            # Use logits-based approach with multi-position analysis
            with torch.no_grad():
                outputs = model(**inputs)
                logits = outputs.logits
                
                # Analyze multiple token positions (last 3 tokens) for better accuracy
                # This helps capture sentiment that might be expressed over multiple tokens
                sentiment_scores = {}
                sentiment_tokens = ['positive', 'negative', 'neutral']
                tokenizer_obj = self.tokenizer.get_tokenizer()
                
                # Look at the last 3 positions (last token is most important)
                positions_to_check = [-1, -2, -3] if logits.shape[1] >= 3 else [-1]
                
                for pos_idx in positions_to_check:
                    if abs(pos_idx) > logits.shape[1]:
                        continue
                    
                    token_logits = logits[0, pos_idx, :]
                    probs = torch.nn.functional.softmax(token_logits, dim=-1)
                    
                    # Get top 100 predictions to find sentiment tokens
                    top_k = 100
                    top_probs, top_indices = torch.topk(probs, top_k)
                    
                    # Weight by position (last token gets full weight, previous tokens get reduced weight)
                    position_weight = 1.0 if pos_idx == -1 else (0.5 if pos_idx == -2 else 0.25)
                    
                    for prob, idx in zip(top_probs, top_indices):
                        token = tokenizer_obj.decode([idx.item()]).strip().lower()
                        weighted_prob = prob.item() * position_weight
                        
                        # Check for exact matches
                        if token in sentiment_tokens:
                            if token not in sentiment_scores or weighted_prob > sentiment_scores.get(token, 0):
                                sentiment_scores[token] = weighted_prob
                        # Check for partial matches (e.g., "positive", "negatively")
                        elif any(sent in token for sent in sentiment_tokens):
                            for sent in sentiment_tokens:
                                if sent in token:
                                    if sent not in sentiment_scores or weighted_prob > sentiment_scores.get(sent, 0):
                                        sentiment_scores[sent] = weighted_prob
                                    break
                
                # Scores are already weighted by position, use as-is
                
                # Enhanced hybrid approach: combine logits with keyword analysis
                if sentiment_scores:
                    # Get the sentiment with highest probability from logits
                    best_sentiment = max(sentiment_scores.items(), key=lambda x: x[1])
                    logits_label = best_sentiment[0]
                    logits_prob = best_sentiment[1]
                    
                    # Get all sentiment probabilities for better decision making
                    pos_prob = sentiment_scores.get('positive', 0.0)
                    neg_prob = sentiment_scores.get('negative', 0.0)
                    neu_prob = sentiment_scores.get('neutral', 0.0)
                    
                    # Get keyword result
                    keyword_label = keyword_result['sentiment']
                    keyword_confidence = keyword_result['confidence']
                    keyword_score = keyword_result['score']
                    
                    # Enhanced decision logic
                    # 1. If logits are very uncertain (< 0.01), trust keywords
                    if logits_prob < 0.01:
                        final_label = keyword_label
                        final_confidence = keyword_confidence
                        method = 'keyword'
                    
                    # 2. If logits are confident (> 0.05) and non-neutral, trust logits
                    elif logits_prob > 0.05 and logits_label != 'neutral':
                        final_label = logits_label
                        final_confidence = min(1.0, logits_prob * 15)
                        method = 'logits'
                    
                    # 3. If keywords strongly suggest non-neutral but logits say neutral
                    elif keyword_label != 'neutral' and logits_label == 'neutral':
                        # Check if keyword confidence is high enough
                        if keyword_confidence > 0.5:
                            final_label = keyword_label
                            final_confidence = keyword_confidence * 0.85  # Slightly reduce
                            method = 'keyword_override'
                        # If logits neutral prob is very high, trust it
                        elif neu_prob > 0.3:
                            final_label = 'neutral'
                            final_confidence = min(1.0, neu_prob * 10)
                            method = 'logits'
                        else:
                            # Use weighted average
                            final_label = keyword_label
                            final_confidence = (keyword_confidence * 0.6) + (logits_prob * 10 * 0.4)
                            method = 'hybrid'
                    
                    # 4. If both agree on non-neutral, use weighted combination
                    elif keyword_label == logits_label and keyword_label != 'neutral':
                        # Both agree - higher confidence
                        final_confidence = min(1.0, (keyword_confidence * 0.5) + (logits_prob * 15 * 0.5))
                        final_label = logits_label
                        method = 'hybrid_agreement'
                    
                    # 5. If they disagree on non-neutral labels
                    elif keyword_label != logits_label and keyword_label != 'neutral' and logits_label != 'neutral':
                        # Use the one with higher confidence
                        keyword_weight = keyword_confidence
                        logits_weight = logits_prob * 15
                        if keyword_weight > logits_weight:
                            final_label = keyword_label
                            final_confidence = keyword_confidence * 0.9
                            method = 'keyword_override'
                        else:
                            final_label = logits_label
                            final_confidence = min(1.0, logits_prob * 15)
                            method = 'logits'
                    
                    # 6. Default to logits
                    else:
                        final_label = logits_label
                        final_confidence = min(1.0, logits_prob * 10)
                        method = 'logits'
                    
                    # Convert to numerical score with better scaling
                    if final_label == 'positive':
                        # Use keyword score if available and method uses keywords
                        if 'keyword' in method and abs(keyword_score) > 0.1:
                            score = keyword_score
                        else:
                            score = 0.5 + (final_confidence * 0.5)  # 0.5 to 1.0
                    elif final_label == 'negative':
                        # Use keyword score if available and method uses keywords
                        if 'keyword' in method and abs(keyword_score) > 0.1:
                            score = keyword_score
                        else:
                            score = -0.5 - (final_confidence * 0.5)  # -1.0 to -0.5
                    else:  # neutral
                        score = 0.0
                    
                    self.logger.debug(f"Logits scores: {sentiment_scores}")
                    self.logger.debug(f"Keyword: {keyword_label} (conf: {keyword_confidence:.3f}, score: {keyword_score:.3f})")
                    self.logger.debug(f"Final: {final_label} (conf: {final_confidence:.3f}, score: {score:.3f}, method: {method})")
                    
                    return {
                        'sentiment': final_label,
                        'score': score,
                        'confidence': final_confidence,
                        'raw_output': final_label,
                        'method': method
                    }
                else:
                    # No sentiment tokens found, use keyword fallback
                    self.logger.warning("No sentiment tokens found in model predictions, using keyword fallback")
                    return keyword_result
            
        except Exception as e:
            self.logger.error(f"Error analyzing sentiment: {str(e)}", exc_info=True)
            return {
                'sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'raw_output': '',
                'error': str(e)
            }
    
    def _fallback_keyword_analysis(self, text: str) -> Dict[str, Any]:
        """
        Enhanced keyword-based sentiment analysis with weighted scoring and negation handling.
        
        Args:
            text: Input text to analyze
            
        Returns:
            Dictionary with sentiment analysis results
        """
        text_lower = text.lower()
        
        # Strong positive indicators (weight: 2.0)
        strong_positive = {
            'surge', 'soar', 'rally', 'breakthrough', 'record-breaking', 'all-time high',
            'surpasses', 'outperforms', 'exceeds', 'milestone', 'celebration', 'booms'
        }
        
        # Moderate positive indicators (weight: 1.5)
        moderate_positive = {
            'jump', 'gain', 'rise', 'strong', 'growth', 'profit', 'beat', 'approval',
            'success', 'record', 'high', 'wins', 'secures', 'expands', 'increases',
            'thriving', 'flourishes', 'prosperous', 'optimistic', 'bullish'
        }
        
        # Weak positive indicators (weight: 1.0)
        weak_positive = {
            'stable', 'steady', 'maintains', 'holds', 'positive', 'upward', 'improves',
            'enhances', 'benefits', 'opportunity', 'potential', 'promising'
        }
        
        # Strong negative indicators (weight: 2.0)
        strong_negative = {
            'crash', 'plummet', 'collapse', 'hack', 'breach', 'crisis', 'panic',
            'bankruptcy', 'scandal', 'lawsuit', 'investigation', 'violation', 'penalty'
        }
        
        # Moderate negative indicators (weight: 1.5)
        moderate_negative = {
            'drop', 'fall', 'decline', 'loss', 'weak', 'disappointing', 'layoff',
            'outage', 'loses', 'drops', 'crashes', 'plummets', 'fails', 'disappoints',
            'struggles', 'concern', 'uncertainty', 'slowdown', 'recession'
        }
        
        # Weak negative indicators (weight: 1.0)
        weak_negative = {
            'decrease', 'reduces', 'down', 'lower', 'negative', 'bearish', 'caution',
            'risk', 'volatility', 'uncertain', 'mixed', 'challenges'
        }
        
        # Negation words that flip sentiment
        negations = {'not', 'no', 'never', 'neither', 'nobody', 'none', 'nothing', 
                    'nowhere', 'without', 'lack', 'lacks', 'lacking', 'fails to',
                    'unable', 'cannot', 'can\'t', 'won\'t', 'don\'t', 'doesn\'t'}
        
        # Context-aware positive phrases (these override word-level analysis)
        positive_phrases = [
            'fees drop', 'costs drop', 'transaction fees drop', 'fees decrease',
            'surges', 'surge', 'soars', 'soar', 'jumps', 'jump', 'gains', 'gain',
            'record-breaking', 'all-time high', 'beats expectations', 'exceeds expectations',
            'successfully completed', 'major breakthrough', 'strong growth', 'robust recovery',
            'stock price surges', 'shares jump', 'shares gain', 'price surges', 'surges %',
            'discovers major', 'major discovery', 'new highs', 'reaches new', 'hits all-time'
        ]
        
        # Context-aware negative phrases
        negative_phrases = [
            'data breach', 'security breach', 'faces data', 'faces investigation', 'faces lawsuit',
            'under pressure', 'profitability under pressure', 'faces regulatory', 'faces scrutiny',
            'crashes', 'plummets', 'disappointing', 'fails to', 'loses subscribers',
            'regulatory scrutiny', 'stock price drops', 'stock drops', 'price drops', 'drops %',
            'increased claims', 'profitability under', 'customer trust erodes'
        ]
        
        # Check for positive phrases first (they override word-level)
        phrase_pos_score = 0.0
        phrase_neg_score = 0.0
        
        for phrase in positive_phrases:
            if phrase in text_lower:
                # Strong positive phrase
                if any(strong in phrase for strong in ['surge', 'soar', 'record', 'breakthrough', 'all-time', 'discovers']):
                    phrase_pos_score += 3.0
                else:
                    phrase_pos_score += 2.0
        
        for phrase in negative_phrases:
            if phrase in text_lower:
                # Strong negative phrase
                if any(strong in phrase for strong in ['breach', 'crash', 'plummet', 'lawsuit', 'investigation', 'under pressure']):
                    phrase_neg_score += 3.0
                else:
                    phrase_neg_score += 2.0
        
        # Calculate weighted scores from individual words
        pos_score = phrase_pos_score  # Start with phrase scores
        neg_score = phrase_neg_score
        
        words = text_lower.split()
        
        for i, word in enumerate(words):
            
            # Check for negations (look at previous 2 words)
            is_negated = False
            for j in range(max(0, i-2), i):
                if words[j] in negations:
                    is_negated = True
                    break
            
            # Check positive keywords
            if word in strong_positive:
                pos_score += 2.0 if not is_negated else -1.5
            elif word in moderate_positive:
                pos_score += 1.5 if not is_negated else -1.0
            elif word in weak_positive:
                pos_score += 1.0 if not is_negated else -0.5
            
            # Check negative keywords
            if word in strong_negative:
                neg_score += 2.0 if not is_negated else -1.5
            elif word in moderate_negative:
                neg_score += 1.5 if not is_negated else -1.0
            elif word in weak_negative:
                neg_score += 1.0 if not is_negated else -0.5
        
        # Handle mixed sentiment (e.g., "Tech sector shows mixed results")
        mixed_indicators = ['mixed', 'both', 'while', 'however', 'but', 'although', 'despite']
        has_mixed = any(indicator in text_lower for indicator in mixed_indicators)
        
        # Calculate confidence based on score difference
        score_diff = abs(pos_score - neg_score)
        total_score = pos_score + neg_score
        
        if total_score == 0:
            confidence = 0.3
        elif score_diff < 1.0:
            # Close scores - likely neutral or mixed
            confidence = 0.4
        elif score_diff < 3.0:
            confidence = 0.5 + (score_diff * 0.1)
        else:
            confidence = min(0.9, 0.6 + (score_diff * 0.05))
        
        # Determine sentiment
        if has_mixed and score_diff < 2.0:
            # Mixed sentiment - return neutral
            return {
                'sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.4,
                'raw_output': 'neutral (mixed)',
                'method': 'keyword_fallback'
            }
        elif pos_score > neg_score:
            # Positive sentiment
            # Scale score based on strength
            strength = min(1.0, pos_score / 5.0)  # Normalize to 0-1
            return {
                'sentiment': 'positive',
                'score': 0.5 + (strength * 0.5),  # 0.5 to 1.0
                'confidence': confidence,
                'raw_output': 'positive (keyword)',
                'method': 'keyword_fallback'
            }
        elif neg_score > pos_score:
            # Negative sentiment
            strength = min(1.0, neg_score / 5.0)  # Normalize to 0-1
            return {
                'sentiment': 'negative',
                'score': -0.5 - (strength * 0.5),  # -1.0 to -0.5
                'confidence': confidence,
                'raw_output': 'negative (keyword)',
                'method': 'keyword_fallback'
            }
        else:
            # Neutral
            return {
                'sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.3,
                'raw_output': 'neutral (keyword)',
                'method': 'keyword_fallback'
            }
    
    def analyze_batch(self, texts: List[str], batch_size: int = 1) -> List[Dict[str, Any]]:
        """
        Analyze sentiment for a batch of texts.
        Note: batch_size=1 for sequential processing to avoid memory issues
        
        Args:
            texts: List of input texts to analyze
            batch_size: Number of texts to process at once (default 1 for stability)
            
        Returns:
            List of sentiment analysis results
        """
        if not texts:
            return []
        
        results = []
        total = len(texts)
        
        for i, text in enumerate(texts, 1):
            result = self.analyze_sentiment(text)
            results.append(result)
            
            # Log progress every 10 items
            if i % 10 == 0:
                self.logger.info(f"Processed {i}/{total} texts")
        
        return results
    
    def analyze_financial_text(
        self,
        text: str,
        source: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Analyze financial text with source metadata.
        
        Args:
            text: Input text to analyze
            source: Optional source identifier
            
        Returns:
            Dictionary with sentiment analysis and metadata
        """
        result = self.analyze_sentiment(text)
        result['source'] = source
        return result
    
    def aggregate_sentiments(
        self,
        sentiment_results: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Aggregate multiple sentiment results into a single score.
        
        Args:
            sentiment_results: List of sentiment analysis results
            
        Returns:
            Dictionary with aggregated sentiment
        """
        if not sentiment_results:
            return {
                'overall_sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'breakdown': {'positive': 0, 'neutral': 0, 'negative': 0}
            }
        
        # Count sentiments weighted by confidence
        sentiment_scores = {'positive': 0.0, 'neutral': 0.0, 'negative': 0.0}
        sentiment_counts = {'positive': 0, 'neutral': 0, 'negative': 0}
        total_confidence = 0.0
        valid_results = 0
        
        for result in sentiment_results:
            sentiment = result.get('sentiment', 'neutral')
            confidence = result.get('confidence', 0.0)
            
            # Only count results with reasonable confidence
            if sentiment in sentiment_scores and confidence > 0.3:
                sentiment_scores[sentiment] += confidence
                sentiment_counts[sentiment] += 1
                total_confidence += confidence
                valid_results += 1
        
        if valid_results == 0 or total_confidence == 0:
            return {
                'overall_sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'breakdown': sentiment_counts,
                'total_texts': 0
            }
        
        # Normalize scores
        normalized_scores = {
            k: v / total_confidence for k, v in sentiment_scores.items()
        }
        
        # Determine overall sentiment (highest normalized score)
        max_sentiment = max(normalized_scores.items(), key=lambda x: x[1])
        overall_sentiment = max_sentiment[0]
        
        # Calculate composite score (-1 to 1)
        # Positive contributes +1, negative contributes -1, neutral contributes 0
        score = (normalized_scores['positive'] - normalized_scores['negative'])
        
        # Average confidence
        avg_confidence = total_confidence / valid_results
        
        return {
            'overall_sentiment': overall_sentiment,
            'score': max(-1.0, min(1.0, score)),  # Clamp to [-1, 1]
            'confidence': avg_confidence,
            'breakdown': sentiment_counts,
            'total_texts': valid_results
        }
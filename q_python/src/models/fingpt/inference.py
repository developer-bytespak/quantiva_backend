"""
FinGPT Inference Pipeline - PRODUCTION READY VERSION
Handles sentiment analysis using the FinGPT model with official prompt format.
"""
import logging
import re
import torch
import threading
import time
from typing import List, Dict, Any, Optional, Tuple
from .model import FinGPTModel
from .tokenizer import FinGPTTokenizer
from src.config import FINGPT_CONFIG

logger = logging.getLogger(__name__)


class TimeoutError(Exception):
    """Custom timeout exception for model inference."""
    pass


class FinGPTInference:
    """
    Production-ready inference class for FinGPT sentiment analysis.
    Uses official FinGPT prompt format with proper escaping.
    """
    
    def __init__(self, use_keyword_fallback: bool = True):
        """
        Initialize inference pipeline with model and tokenizer.
        
        Args:
            use_keyword_fallback: If False, only use model predictions (no keyword fallback).
                                  Default True for hybrid approach.
        """
        self.logger = logging.getLogger(__name__)
        self.model_manager = FinGPTModel()
        self.tokenizer = FinGPTTokenizer()
        self.max_new_tokens = FINGPT_CONFIG.get("max_new_tokens", 15)
        self.temperature = FINGPT_CONFIG.get("temperature", 0.1)
        self.top_p = FINGPT_CONFIG.get("top_p", 0.9)
        self.do_sample = FINGPT_CONFIG.get("do_sample", True)
        self.inference_timeout = FINGPT_CONFIG.get("inference_timeout", 30)
        self.use_keyword_fallback = use_keyword_fallback
        self._model = None
        self._last_use_time = None
        self._method_stats = {
            'model_only': 0,
            'keyword_fallback': 0,
            'hybrid': 0,
            'keyword_override': 0,
            'hybrid_agreement': 0,
            'errors': 0,
            'timeouts': 0
        }
    
    def _get_model(self):
        """Get model instance, loading if necessary. Checks for idle timeout."""
        # Check if model should be unloaded due to idle timeout
        if self._model is not None and self._last_use_time is not None:
            idle_timeout = FINGPT_CONFIG.get("idle_timeout", 3600)
            if self.model_manager.check_idle_timeout(self._last_use_time, idle_timeout):
                self.logger.info("Unloading model due to idle timeout")
                self.model_manager.unload()
                self._model = None
        
        if self._model is None:
            self._model = self.model_manager.get_model()
            self._last_use_time = time.time()
        else:
            self._last_use_time = time.time()
        return self._model
    
    def _generate_with_timeout(self, model, inputs, tokenizer_obj):
        """
        Generate text with timeout protection.
        
        Args:
            model: The model to use for generation
            inputs: Tokenized inputs
            tokenizer_obj: Tokenizer object
            
        Returns:
            Generated token IDs
            
        Raises:
            TimeoutError: If generation exceeds timeout
        """
        result = [None]
        exception = [None]
        
        def _generate():
            try:
                do_sample = True
                gen_temperature = max(0.1, self.temperature)
                
                generated_ids = model.generate(
                    input_ids=inputs['input_ids'],
                    attention_mask=inputs['attention_mask'],
                    max_new_tokens=self.max_new_tokens,
                    temperature=gen_temperature,
                    do_sample=do_sample,
                    top_p=self.top_p,
                    pad_token_id=tokenizer_obj.pad_token_id or tokenizer_obj.eos_token_id,
                    eos_token_id=tokenizer_obj.eos_token_id,
                    repetition_penalty=1.1,
                )
                result[0] = generated_ids
            except Exception as e:
                exception[0] = e
        
        thread = threading.Thread(target=_generate)
        thread.daemon = True
        thread.start()
        thread.join(timeout=self.inference_timeout)
        
        if thread.is_alive():
            self.logger.error(f"Model generation timed out after {self.inference_timeout}s")
            self._method_stats['timeouts'] += 1
            raise TimeoutError(f"Model inference exceeded timeout of {self.inference_timeout} seconds")
        
        if exception[0]:
            raise exception[0]
        
        if result[0] is None:
            raise TimeoutError("Model generation did not complete")
        
        return result[0]
    
    def _parse_generated_sentiment(self, generated_text: str) -> Tuple[str, float]:
        """
        Parse sentiment from generated text.
        Model generates single word: "positive", "negative", or "neutral"
        
        Args:
            generated_text: Raw generated text from model
            
        Returns:
            Tuple of (sentiment_label, confidence)
        """
        if not generated_text:
            return 'neutral', 0.3
        
        text_lower = generated_text.strip().lower()
        
        # Exact matches (high confidence)
        if text_lower == 'positive':
            return 'positive', 0.9
        elif text_lower == 'negative':
            return 'negative', 0.9
        elif text_lower == 'neutral':
            return 'neutral', 0.9
        
        # Handle variations: "positive.", "Positive", "positive\n", etc.
        if text_lower.startswith('positive') or 'positive' in text_lower:
            return 'positive', 0.8
        elif text_lower.startswith('negative') or 'negative' in text_lower:
            return 'negative', 0.8
        elif text_lower.startswith('neutral') or 'neutral' in text_lower:
            return 'neutral', 0.8
        
        # Fallback: try to extract from longer text
        if 'positive' in text_lower and 'negative' not in text_lower:
            return 'positive', 0.7
        elif 'negative' in text_lower and 'positive' not in text_lower:
            return 'negative', 0.7
        
        # Default fallback
        self.logger.warning(f"Could not parse sentiment from: '{generated_text}'")
        return 'neutral', 0.5
    
    def analyze_sentiment(self, text: str) -> Dict[str, Any]:
        """
        Analyze sentiment using FinGPT text generation.
        
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
            # Get keyword result only if fallback is enabled
            keyword_result = None
            if self.use_keyword_fallback:
                keyword_result = self._fallback_keyword_analysis(text)
            
            # CRITICAL: Use official FinGPT prompt format with f-string (not .format())
            # Don't use .format() - it can interfere with curly braces
            # Build prompt directly with f-string
            prompt = f"Instruction: What is the sentiment of this news? Please choose an answer from {{negative/neutral/positive}}.\nInput: {text}\nAnswer:"
            
            # Verify the braces are actually in the prompt
            if '{negative' not in prompt:
                self.logger.error(f"CRITICAL: Curly braces missing from prompt! Got: {prompt[:200]}")
            
            # Log prompt for debugging (first call only)
            if not hasattr(self, '_prompt_logged'):
                self.logger.info(f"Sample prompt format: {prompt[:200]}")
                self._prompt_logged = True
            
            # Tokenize directly using underlying tokenizer
            tokenizer_obj = self.tokenizer.get_tokenizer()
            
            inputs = tokenizer_obj(
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
            
            # Generate text with timeout protection
            with torch.no_grad():
                try:
                    generated_ids = self._generate_with_timeout(model, inputs, tokenizer_obj)
                except TimeoutError as e:
                    self.logger.error(f"Inference timeout: {str(e)}")
                    # Fallback to keyword analysis if available
                    if keyword_result:
                        self.logger.warning("Using keyword fallback due to timeout")
                        return {
                            'sentiment': keyword_result['sentiment'],
                            'score': keyword_result['score'],
                            'confidence': keyword_result['confidence'] * 0.7,  # Reduce confidence due to timeout
                            'raw_output': 'timeout_fallback',
                            'method': 'keyword_fallback',
                            'error': True,
                            'error_message': str(e),
                            'timeout': True
                        }
                    else:
                        # Return neutral with error flag
                        return {
                            'sentiment': 'neutral',
                            'score': 0.0,
                            'confidence': 0.0,
                            'raw_output': '',
                            'method': 'error',
                            'error': True,
                            'error_message': str(e),
                            'timeout': True
                        }
                
                # Extract only the generated part (skip input tokens)
                input_length = inputs['input_ids'].shape[1]
                generated_tokens = generated_ids[0][input_length:]
                generated_text = tokenizer_obj.decode(
                    generated_tokens, 
                    skip_special_tokens=True
                ).strip()
                
                # Debug logging for first few calls
                if not hasattr(self, '_debug_count'):
                    self._debug_count = 0
                if self._debug_count < 3:
                    full_output = tokenizer_obj.decode(generated_ids[0], skip_special_tokens=True)
                    self.logger.info(f"DEBUG [{self._debug_count}]: Generated text: '{generated_text}'")
                    self.logger.info(f"DEBUG [{self._debug_count}]: Full output: {full_output[:250]}...")
                    self._debug_count += 1
                
                # Handle edge case: model generates "No", "n", or empty
                if generated_text.lower() in ['no', 'n', ''] or not generated_text:
                    self.logger.debug(f"Model generated '{generated_text}', checking logits")
                    
                    # Get logits to find actual sentiment
                    outputs = model(**inputs)
                    logits = outputs.logits
                    last_logits = logits[0, -1, :]
                    probs = torch.nn.functional.softmax(last_logits, dim=-1)
                    
                    # Get token IDs for sentiment words
                    sentiment_words = ['positive', 'negative', 'neutral']
                    sentiment_scores = {}
                    
                    for word in sentiment_words:
                        word_ids = tokenizer_obj.encode(word, add_special_tokens=False)
                        if word_ids:
                            token_id = word_ids[0]
                            prob = probs[token_id].item()
                            sentiment_scores[word] = prob
                    
                    # Check top-k predictions
                    top_k = 50
                    top_probs, top_indices = torch.topk(probs, top_k)
                    for prob, idx in zip(top_probs, top_indices):
                        token = tokenizer_obj.decode([idx.item()]).strip().lower()
                        for sent_word in sentiment_words:
                            if sent_word in token or token == sent_word:
                                if sent_word not in sentiment_scores or prob.item() > sentiment_scores[sent_word]:
                                    sentiment_scores[sent_word] = prob.item()
                                break
                    
                    # Use sentiment with highest probability
                    if sentiment_scores:
                        best_sentiment = max(sentiment_scores.items(), key=lambda x: x[1])
                        generated_text = best_sentiment[0]
                        self.logger.debug(f"Logits override: '{generated_text}' (prob: {best_sentiment[1]:.4f})")
                    else:
                        # Fallback to keyword analysis
                        if keyword_result:
                            generated_text = keyword_result['sentiment']
                            self.logger.debug(f"Using keyword fallback: '{generated_text}'")
                        else:
                            generated_text = 'neutral'
                
                # Parse generated text
                model_sentiment_label, model_confidence = self._parse_generated_sentiment(generated_text)
                
                # Model-only mode
                if not self.use_keyword_fallback:
                    if model_sentiment_label == 'positive':
                        score = 0.5 + (model_confidence * 0.5)
                    elif model_sentiment_label == 'negative':
                        score = -0.5 - (model_confidence * 0.5)
                    else:
                        score = 0.0
                    
                    self._method_stats['model_only'] += 1
                    
                    return {
                        'sentiment': model_sentiment_label,
                        'score': score,
                        'confidence': model_confidence,
                        'raw_output': generated_text,
                        'method': 'model_only',
                        'generated_text': generated_text
                    }
                
                # Hybrid mode: combine model + keywords
                keyword_label = keyword_result['sentiment']
                keyword_confidence = keyword_result['confidence']
                keyword_score = keyword_result['score']
                
                # Decision logic
                if model_confidence > 0.8:
                    final_label = model_sentiment_label
                    final_confidence = model_confidence
                    method = 'model_only'
                    self._method_stats['model_only'] += 1
                
                elif model_sentiment_label == keyword_label:
                    final_label = model_sentiment_label
                    final_confidence = min(1.0, (model_confidence * 0.6) + (keyword_confidence * 0.4))
                    method = 'hybrid_agreement'
                    self._method_stats['hybrid_agreement'] += 1
                
                elif model_confidence > 0.7:
                    final_label = model_sentiment_label
                    final_confidence = model_confidence * 0.9
                    method = 'model_only'
                    self._method_stats['model_only'] += 1
                
                elif keyword_confidence > 0.7 and model_confidence < 0.6:
                    final_label = keyword_label
                    final_confidence = keyword_confidence * 0.85
                    method = 'keyword_override'
                    self._method_stats['keyword_override'] += 1
                
                elif model_sentiment_label == 'neutral' and keyword_label != 'neutral':
                    if keyword_confidence > 0.6:
                        final_label = keyword_label
                        final_confidence = keyword_confidence * 0.8
                        method = 'keyword_override'
                        self._method_stats['keyword_override'] += 1
                    else:
                        final_label = 'neutral'
                        final_confidence = model_confidence
                        method = 'model_only'
                        self._method_stats['model_only'] += 1
                
                else:
                    final_label = model_sentiment_label
                    final_confidence = model_confidence
                    method = 'model_only'
                    self._method_stats['model_only'] += 1
                
                # Convert to score
                if final_label == 'positive':
                    if 'keyword' in method and abs(keyword_score) > 0.1:
                        score = keyword_score
                    else:
                        score = 0.5 + (final_confidence * 0.5)
                elif final_label == 'negative':
                    if 'keyword' in method and abs(keyword_score) > 0.1:
                        score = keyword_score
                    else:
                        score = -0.5 - (final_confidence * 0.5)
                else:
                    score = 0.0
                
                self.logger.debug(f"Model: {model_sentiment_label} ({model_confidence:.3f})")
                if keyword_result:
                    self.logger.debug(f"Keyword: {keyword_label} ({keyword_confidence:.3f})")
                self.logger.debug(f"Final: {final_label} ({final_confidence:.3f}, method: {method})")
                
                return {
                    'sentiment': final_label,
                    'score': score,
                    'confidence': final_confidence,
                    'raw_output': generated_text,
                    'method': method,
                    'generated_text': generated_text,
                    'model_sentiment': model_sentiment_label,
                    'model_confidence': model_confidence
                }
            
        except TimeoutError as e:
            self.logger.error(f"Inference timeout: {str(e)}", exc_info=True)
            self._method_stats['errors'] += 1
            self._method_stats['timeouts'] += 1
            return {
                'sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'raw_output': '',
                'error': True,
                'error_message': str(e),
                'timeout': True,
                'method': 'error'
            }
        except Exception as e:
            self.logger.error(f"Error analyzing sentiment: {str(e)}", exc_info=True)
            self._method_stats['errors'] += 1
            return {
                'sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'raw_output': '',
                'error': True,
                'error_message': str(e),
                'method': 'error'
            }
    
    def _fallback_keyword_analysis(self, text: str) -> Dict[str, Any]:
        """
        Enhanced keyword-based sentiment analysis with context awareness.
        
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
        
        # Context-aware positive phrases
        positive_phrases = [
            'fees drop', 'costs drop', 'transaction fees drop', 'fees decrease',
            'surges', 'soars', 'jumps', 'gains', 'record-breaking', 'all-time high',
            'beats expectations', 'exceeds expectations', 'successfully completed',
            'stock price surges', 'shares jump', 'price surges', 'discovers major',
            'new highs', 'reaches new', 'hits all-time'
        ]
        
        # Context-aware negative phrases
        negative_phrases = [
            'data breach', 'security breach', 'under pressure', 'profitability under pressure',
            'faces regulatory', 'faces scrutiny', 'crashes', 'plummets', 'disappointing',
            'loses subscribers', 'regulatory scrutiny', 'stock price drops', 'stock drops',
            'increased claims', 'customer trust erodes'
        ]
        
        # Check phrases first
        phrase_pos_score = 0.0
        phrase_neg_score = 0.0
        
        for phrase in positive_phrases:
            if phrase in text_lower:
                if any(strong in phrase for strong in ['surge', 'soar', 'record', 'breakthrough', 'all-time']):
                    phrase_pos_score += 3.0
                else:
                    phrase_pos_score += 2.0
        
        for phrase in negative_phrases:
            if phrase in text_lower:
                if any(strong in phrase for strong in ['breach', 'crash', 'plummet', 'under pressure']):
                    phrase_neg_score += 3.0
                else:
                    phrase_neg_score += 2.0
        
        # Calculate word-level scores
        pos_score = phrase_pos_score
        neg_score = phrase_neg_score
        
        words = text_lower.split()
        
        for word in words:
            if word in strong_positive:
                pos_score += 2.0
            elif word in moderate_positive:
                pos_score += 1.5
            elif word in weak_positive:
                pos_score += 1.0
            
            if word in strong_negative:
                neg_score += 2.0
            elif word in moderate_negative:
                neg_score += 1.5
            elif word in weak_negative:
                neg_score += 1.0
        
        # Calculate confidence
        score_diff = abs(pos_score - neg_score)
        total_score = pos_score + neg_score
        
        if total_score == 0:
            confidence = 0.3
        elif score_diff < 1.0:
            confidence = 0.4
        elif score_diff < 3.0:
            confidence = 0.5 + (score_diff * 0.1)
        else:
            confidence = min(0.9, 0.6 + (score_diff * 0.05))
        
        # Determine sentiment
        if pos_score > neg_score:
            strength = min(1.0, pos_score / 5.0)
            return {
                'sentiment': 'positive',
                'score': 0.5 + (strength * 0.5),
                'confidence': confidence,
                'raw_output': 'positive (keyword)',
                'method': 'keyword_fallback'
            }
        elif neg_score > pos_score:
            strength = min(1.0, neg_score / 5.0)
            return {
                'sentiment': 'negative',
                'score': -0.5 - (strength * 0.5),
                'confidence': confidence,
                'raw_output': 'negative (keyword)',
                'method': 'keyword_fallback'
            }
        else:
            return {
                'sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.3,
                'raw_output': 'neutral (keyword)',
                'method': 'keyword_fallback'
            }
    
    def get_method_stats(self) -> Dict[str, int]:
        """Get statistics about which methods were used."""
        return self._method_stats.copy()
    
    def reset_method_stats(self):
        """Reset method usage statistics."""
        self._method_stats = {
            'model_only': 0,
            'keyword_fallback': 0,
            'hybrid': 0,
            'keyword_override': 0,
            'hybrid_agreement': 0,
            'errors': 0
        }
    
    def analyze_batch(self, texts: List[str], batch_size: int = 1) -> List[Dict[str, Any]]:
        """
        Analyze sentiment for a batch of texts.
        
        Args:
            texts: List of input texts to analyze
            batch_size: Number of texts to process at once (default 1)
            
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
        Handles error flags and timeouts appropriately.
        
        Args:
            sentiment_results: List of sentiment analysis results
            
        Returns:
            Dictionary with aggregated sentiment and error information
        """
        if not sentiment_results:
            return {
                'overall_sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'breakdown': {'positive': 0, 'neutral': 0, 'negative': 0},
                'error': False
            }
        
        sentiment_scores = {'positive': 0.0, 'neutral': 0.0, 'negative': 0.0}
        sentiment_counts = {'positive': 0, 'neutral': 0, 'negative': 0}
        total_confidence = 0.0
        valid_results = 0
        error_count = 0
        timeout_count = 0
        error_messages = []
        
        for result in sentiment_results:
            # Check for errors
            if result.get('error', False):
                error_count += 1
                if result.get('timeout', False):
                    timeout_count += 1
                error_msg = result.get('error_message', 'Unknown error')
                if error_msg:
                    error_messages.append(error_msg)
                continue
            
            sentiment = result.get('sentiment', 'neutral')
            confidence = result.get('confidence', 0.0)
            
            if sentiment in sentiment_scores and confidence > 0.3:
                sentiment_scores[sentiment] += confidence
                sentiment_counts[sentiment] += 1
                total_confidence += confidence
                valid_results += 1
        
        # If all results had errors, return error state
        if valid_results == 0:
            return {
                'overall_sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'breakdown': sentiment_counts,
                'total_texts': 0,
                'error': True,
                'error_count': error_count,
                'timeout_count': timeout_count,
                'error_messages': error_messages[:5]  # Limit to first 5 errors
            }
        
        if total_confidence == 0:
            return {
                'overall_sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'breakdown': sentiment_counts,
                'total_texts': 0,
                'error': error_count > 0,
                'error_count': error_count,
                'timeout_count': timeout_count
            }
        
        normalized_scores = {
            k: v / total_confidence for k, v in sentiment_scores.items()
        }
        
        max_sentiment = max(normalized_scores.items(), key=lambda x: x[1])
        overall_sentiment = max_sentiment[0]
        
        score = (normalized_scores['positive'] - normalized_scores['negative'])
        avg_confidence = total_confidence / valid_results
        
        # Reduce confidence if there were errors
        if error_count > 0:
            error_penalty = min(0.3, error_count * 0.1)
            avg_confidence = max(0.1, avg_confidence - error_penalty)
        
        return {
            'overall_sentiment': overall_sentiment,
            'score': max(-1.0, min(1.0, score)),
            'confidence': avg_confidence,
            'breakdown': sentiment_counts,
            'total_texts': valid_results,
            'error': error_count > 0,
            'error_count': error_count,
            'timeout_count': timeout_count,
            'error_messages': error_messages[:3] if error_messages else None
        }
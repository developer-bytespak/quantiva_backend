"""
FinBERT Inference Pipeline
Handles sentiment analysis using the ProsusAI/finbert model.
"""
import logging
import torch
import threading
import time
from typing import List, Dict, Any, Optional, Tuple
from .model import FinBERTModel
from src.config import FINBERT_CONFIG

logger = logging.getLogger(__name__)


class TimeoutError(Exception):
    """Custom timeout exception for model inference."""
    pass


class FinBERTInference:
    """
    Production-ready inference class for FinBERT sentiment analysis.
    """
    
    def __init__(self):
        """Initialize inference pipeline with model and tokenizer."""
        self.logger = logging.getLogger(__name__)
        self.model_manager = FinBERTModel()
        self.max_length = FINBERT_CONFIG.get("max_length", 512)
        self.batch_size = FINBERT_CONFIG.get("batch_size", 8)
        self.inference_timeout = FINBERT_CONFIG.get("inference_timeout", 30)
        self._model = None
        self._tokenizer = None
        self._last_use_time = None
        
        # Sentiment label mapping (FinBERT outputs: 0=positive, 1=negative, 2=neutral)
        self.label_map = {0: 'positive', 1: 'negative', 2: 'neutral'}
    
    def _get_model(self) -> Tuple:
        """Get model and tokenizer instances, loading if necessary. Checks for idle timeout."""
        # Check if model should be unloaded due to idle timeout
        if self._model is not None and self._last_use_time is not None:
            idle_timeout = FINBERT_CONFIG.get("idle_timeout", 3600)
            if self.model_manager.check_idle_timeout(self._last_use_time, idle_timeout):
                self.logger.info("Unloading model due to idle timeout")
                self.model_manager.unload()
                self._model = None
                self._tokenizer = None
        
        if self._model is None or self._tokenizer is None:
            self._model, self._tokenizer = self.model_manager.get_model()
            self._last_use_time = time.time()
        else:
            self._last_use_time = time.time()
        return self._model, self._tokenizer
    
    def _infer_with_timeout(self, model, inputs, device):
        """
        Run inference with timeout protection.
        
        Args:
            model: The model to use for inference
            inputs: Tokenized inputs
            device: Device string ('cuda' or 'cpu')
            
        Returns:
            Model outputs (logits)
            
        Raises:
            TimeoutError: If inference exceeds timeout
        """
        result = [None]
        exception = [None]
        
        def _infer():
            try:
                with torch.no_grad():
                    outputs = model(**inputs)
                result[0] = outputs
            except Exception as e:
                exception[0] = e
        
        thread = threading.Thread(target=_infer)
        thread.daemon = True
        thread.start()
        thread.join(timeout=self.inference_timeout)
        
        if thread.is_alive():
            self.logger.error(f"Model inference timed out after {self.inference_timeout}s")
            raise TimeoutError(f"Model inference exceeded timeout of {self.inference_timeout} seconds")
        
        if exception[0]:
            raise exception[0]
        
        if result[0] is None:
            raise TimeoutError("Model inference did not complete")
        
        return result[0]
    
    def _parse_sentiment(self, logits: torch.Tensor) -> Tuple[str, float]:
        """
        Parse sentiment from model logits.
        
        Args:
            logits: Model output logits [batch_size, num_labels]
            
        Returns:
            Tuple of (sentiment_label, confidence)
        """
        # Apply softmax to get probabilities
        probs = torch.nn.functional.softmax(logits, dim=-1)
        
        # Get predicted class (highest probability)
        predicted_class = torch.argmax(probs, dim=-1).item()
        confidence = probs[0][predicted_class].item()
        
        # Map to sentiment label
        sentiment_label = self.label_map.get(predicted_class, 'neutral')
        
        return sentiment_label, confidence
    
    def analyze_sentiment(self, text: str) -> Dict[str, Any]:
        """
        Analyze sentiment using FinBERT.
        
        Args:
            text: Input text to analyze
            
        Returns:
            Dictionary with sentiment analysis results:
            {
                'sentiment': 'positive' | 'negative' | 'neutral',
                'score': float (-1.0 to 1.0),
                'confidence': float (0.0 to 1.0),
                'raw_output': str
            }
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
            # Get model and tokenizer
            model, tokenizer = self._get_model()
            device = self.model_manager.device
            
            # Tokenize input
            inputs = tokenizer(
                text,
                padding=True,
                truncation=True,
                max_length=self.max_length,
                return_tensors="pt"
            )
            
            # Move to device
            if device == "cuda" and torch.cuda.is_available():
                inputs = {k: v.to(device) for k, v in inputs.items()}
            
            # Run inference with timeout
            try:
                outputs = self._infer_with_timeout(model, inputs, device)
                logits = outputs.logits
            except TimeoutError as e:
                self.logger.error(f"Inference timeout: {str(e)}")
                return {
                    'sentiment': 'neutral',
                    'score': 0.0,
                    'confidence': 0.0,
                    'raw_output': '',
                    'error': True,
                    'error_message': str(e),
                    'timeout': True
                }
            
            # Parse sentiment
            sentiment_label, confidence = self._parse_sentiment(logits)
            
            # Convert to score (-1.0 to 1.0)
            if sentiment_label == 'positive':
                score = 0.5 + (confidence * 0.5)  # 0.5 to 1.0
            elif sentiment_label == 'negative':
                score = -0.5 - (confidence * 0.5)  # -0.5 to -1.0
            else:
                score = 0.0  # neutral
            
            return {
                'sentiment': sentiment_label,
                'score': score,
                'confidence': confidence,
                'raw_output': sentiment_label
            }
            
        except Exception as e:
            self.logger.error(f"Error analyzing sentiment: {str(e)}", exc_info=True)
            return {
                'sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'raw_output': '',
                'error': True,
                'error_message': str(e)
            }
    
    def analyze_batch(self, texts: List[str], batch_size: Optional[int] = None) -> List[Dict[str, Any]]:
        """
        Analyze sentiment for a batch of texts.
        
        Args:
            texts: List of input texts to analyze
            batch_size: Number of texts to process at once (default from config)
            
        Returns:
            List of sentiment analysis results
        """
        if not texts:
            return []
        
        batch_size = batch_size or self.batch_size
        results = []
        total = len(texts)
        
        for i in range(0, total, batch_size):
            batch = texts[i:i + batch_size]
            batch_results = self._analyze_batch_internal(batch)
            results.extend(batch_results)
            
            if (i + batch_size) % 50 == 0:
                self.logger.info(f"Processed {min(i + batch_size, total)}/{total} texts")
        
        return results
    
    def _analyze_batch_internal(self, texts: List[str]) -> List[Dict[str, Any]]:
        """Internal method to analyze a batch of texts."""
        try:
            # Get model and tokenizer
            model, tokenizer = self._get_model()
            device = self.model_manager.device
            
            # Tokenize batch
            inputs = tokenizer(
                texts,
                padding=True,
                truncation=True,
                max_length=self.max_length,
                return_tensors="pt"
            )
            
            # Move to device
            if device == "cuda" and torch.cuda.is_available():
                inputs = {k: v.to(device) for k, v in inputs.items()}
            
            # Run inference
            with torch.no_grad():
                outputs = model(**inputs)
                logits = outputs.logits
            
            # Parse results for each text
            results = []
            probs = torch.nn.functional.softmax(logits, dim=-1)
            
            for i in range(len(texts)):
                predicted_class = torch.argmax(probs[i]).item()
                confidence = probs[i][predicted_class].item()
                sentiment_label = self.label_map.get(predicted_class, 'neutral')
                
                # Convert to score
                if sentiment_label == 'positive':
                    score = 0.5 + (confidence * 0.5)
                elif sentiment_label == 'negative':
                    score = -0.5 - (confidence * 0.5)
                else:
                    score = 0.0
                
                results.append({
                    'sentiment': sentiment_label,
                    'score': score,
                    'confidence': confidence,
                    'raw_output': sentiment_label
                })
            
            return results
            
        except Exception as e:
            self.logger.error(f"Error analyzing batch: {str(e)}", exc_info=True)
            # Return neutral results for failed batch
            return [{
                'sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'raw_output': '',
                'error': True,
                'error_message': str(e)
            } for _ in texts]
    
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
                'error_messages': error_messages[:5]
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
        
        # Normalize scores
        normalized_scores = {
            k: v / total_confidence for k, v in sentiment_scores.items()
        }
        
        # Determine overall sentiment
        max_sentiment = max(normalized_scores.items(), key=lambda x: x[1])
        overall_sentiment = max_sentiment[0]
        
        # Calculate weighted score
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


"""
FinBERT Model Loading and Management
Handles loading of the ProsusAI/finbert model for sentiment analysis.
"""
import os
import logging
import time
import torch
from typing import Optional, Tuple
from transformers import AutoModelForSequenceClassification, AutoTokenizer
from src.config import FINBERT_CONFIG

# Try to load .env file if python-dotenv is available
try:
    from dotenv import load_dotenv
    # Load .env from project root (q_python directory)
    env_path = os.path.join(os.path.dirname(__file__), '..', '..', '..', '.env')
    if os.path.exists(env_path):
        load_dotenv(env_path)
    # Also try loading from current directory
    load_dotenv()
except ImportError:
    pass  # dotenv not installed, skip

logger = logging.getLogger(__name__)


class FinBERTModel:
    """
    Singleton class for managing FinBERT model loading and caching.
    Implements lazy loading pattern to defer model loading until first use.
    """
    
    _instance: Optional['FinBERTModel'] = None
    _model: Optional[AutoModelForSequenceClassification] = None
    _tokenizer: Optional[AutoTokenizer] = None
    _is_loaded: bool = False
    
    def __new__(cls):
        """Singleton pattern implementation."""
        if cls._instance is None:
            cls._instance = super(FinBERTModel, cls).__new__(cls)
        return cls._instance
    
    def __init__(self):
        """Initialize model manager (model not loaded yet)."""
        if not hasattr(self, '_initialized'):
            self._initialized = True
            self.logger = logging.getLogger(__name__)
            self.device = self._detect_device()
            self.model_path = FINBERT_CONFIG.get("model_path", "ProsusAI/finbert")
            self.cache_dir = FINBERT_CONFIG.get("cache_dir", os.path.expanduser("~/.cache/huggingface"))
            self.max_length = FINBERT_CONFIG.get("max_length", 512)
    
    def _detect_device(self) -> str:
        """
        Detect and return the appropriate device (cuda/cpu).
        
        Returns:
            Device string ('cuda' or 'cpu')
        """
        device_config = FINBERT_CONFIG.get("device", "auto")
        
        if device_config == "auto":
            if torch.cuda.is_available():
                device = "cuda"
                device_name = torch.cuda.get_device_name(0) if torch.cuda.device_count() > 0 else "Unknown"
                self.logger.info(f"CUDA available, using GPU: {device_name}")
            else:
                device = "cpu"
                self.logger.warning("CUDA not available, falling back to CPU (inference will be slower)")
        else:
            device = device_config
            if device == "cuda" and not torch.cuda.is_available():
                self.logger.warning(f"CUDA requested but not available, falling back to CPU")
                device = "cpu"
            elif device == "cuda":
                device_name = torch.cuda.get_device_name(0) if torch.cuda.device_count() > 0 else "Unknown"
                self.logger.info(f"Using GPU: {device_name}")
            else:
                self.logger.info(f"Using device: {device}")
        
        return device
    
    def load(self) -> Tuple[AutoModelForSequenceClassification, AutoTokenizer]:
        """
        Load the FinBERT model and tokenizer.
        Uses lazy loading - only loads when first called.
        
        Returns:
            Tuple of (model, tokenizer)
            
        Raises:
            RuntimeError: If model loading fails
        """
        if self._is_loaded and self._model is not None and self._tokenizer is not None:
            self.logger.debug("Model already loaded, returning cached instance")
            return self._model, self._tokenizer
        
        try:
            self.logger.info("Loading FinBERT model...")
            self.logger.info(f"Model: {self.model_path}")
            self.logger.info(f"Using dtype: {torch.float32}")
            self.logger.info(f"Device: {self.device}")
            self.logger.info(f"CUDA available: {torch.cuda.is_available()}")
            if torch.cuda.is_available():
                self.logger.info(f"CUDA device count: {torch.cuda.device_count()}")
                self.logger.info(f"Current CUDA device: {torch.cuda.current_device()}")
                self.logger.info(f"CUDA device name: {torch.cuda.get_device_name(0)}")
            
            # Load tokenizer
            self.logger.info("Loading tokenizer...")
            self._tokenizer = AutoTokenizer.from_pretrained(
                self.model_path,
                cache_dir=self.cache_dir,
            )
            
            # Load model
            self.logger.info("Loading model...")
            self._model = AutoModelForSequenceClassification.from_pretrained(
                self.model_path,
                cache_dir=self.cache_dir,
            )
            
            # Move model to device
            if self.device == "cuda" and torch.cuda.is_available():
                self._model = self._model.to(self.device)
                self.logger.info("Model moved to CUDA")
            else:
                self._model = self._model.to("cpu")
                self.logger.info("Model on CPU")
            
            # Set to evaluation mode
            self._model.eval()
            
            self._is_loaded = True
            self.logger.info("FinBERT model loaded successfully")
            
            # Warm up the model
            self._warm_up()
            
            return self._model, self._tokenizer
            
        except Exception as e:
            error_msg = str(e)
            self.logger.error(f"Error loading FinBERT model: {error_msg}")
            raise RuntimeError(f"Failed to load FinBERT model: {str(e)}")
    
    def _warm_up(self):
        """
        Warm up the model with a dummy inference to initialize CUDA kernels.
        This reduces latency for the first real inference.
        """
        try:
            self.logger.info("Warming up model...")
            dummy_text = "This is a test financial news article."
            if self._model and self._tokenizer:
                inputs = self._tokenizer(
                    dummy_text,
                    padding=True,
                    truncation=True,
                    max_length=self.max_length,
                    return_tensors="pt"
                )
                if self.device == "cuda" and torch.cuda.is_available():
                    inputs = {k: v.to(self.device) for k, v in inputs.items()}
                
                with torch.no_grad():
                    _ = self._model(**inputs)
                self.logger.info("Model warm-up completed")
        except Exception as e:
            self.logger.warning(f"Model warm-up failed (non-critical): {str(e)}")
    
    def get_model(self) -> Tuple[AutoModelForSequenceClassification, AutoTokenizer]:
        """
        Get the loaded model and tokenizer, loading them if necessary.
        
        Returns:
            Tuple of (model, tokenizer)
        """
        if not self._is_loaded:
            return self.load()
        return self._model, self._tokenizer
    
    def is_loaded(self) -> bool:
        """Check if model is loaded."""
        return self._is_loaded
    
    def unload(self):
        """Unload the model to free memory."""
        if self._model is not None:
            self.logger.info("Unloading model to free memory...")
            del self._model
            del self._tokenizer
            self._model = None
            self._tokenizer = None
            self._is_loaded = False
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                self.logger.info("CUDA cache cleared")
            self.logger.info("Model unloaded and memory freed")
    
    def check_idle_timeout(self, last_use_time: Optional[float], idle_timeout: int = 3600) -> bool:
        """
        Check if model should be unloaded due to idle timeout.
        
        Args:
            last_use_time: Timestamp of last model use (None if never used)
            idle_timeout: Idle timeout in seconds (default 1 hour)
            
        Returns:
            True if model should be unloaded, False otherwise
        """
        if not FINBERT_CONFIG.get("enable_auto_unload", False):
            return False
        
        if last_use_time is None:
            return False
        
        idle_duration = time.time() - last_use_time
        if idle_duration > idle_timeout:
            self.logger.info(f"Model idle for {idle_duration:.0f}s, exceeds timeout of {idle_timeout}s")
            return True
        
        return False


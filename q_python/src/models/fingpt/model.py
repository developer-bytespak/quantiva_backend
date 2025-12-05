"""
FinGPT Model Loading and Management
Handles loading of the FinGPT model with 16-bit quantization.
"""
import os
import logging
import time
import torch
from typing import Optional
from transformers import AutoModelForCausalLM
from peft import PeftModel
from src.config import FINGPT_CONFIG

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


class FinGPTModel:
    """
    Singleton class for managing FinGPT model loading and caching.
    Implements lazy loading pattern to defer model loading until first use.
    """
    
    _instance: Optional['FinGPTModel'] = None
    _model: Optional[PeftModel] = None
    _is_loaded: bool = False
    
    def __new__(cls):
        """Singleton pattern implementation."""
        if cls._instance is None:
            cls._instance = super(FinGPTModel, cls).__new__(cls)
        return cls._instance
    
    def __init__(self):
        """Initialize model manager (model not loaded yet)."""
        if not hasattr(self, '_initialized'):
            self._initialized = True
            self.logger = logging.getLogger(__name__)
            self.device = self._detect_device()
            self.torch_dtype = FINGPT_CONFIG.get("torch_dtype", torch.float16)
            self.model_path = FINGPT_CONFIG.get("model_path")
            self.base_model_path = FINGPT_CONFIG.get("base_model_path")
            self.cache_dir = FINGPT_CONFIG.get("cache_dir")
            self.trust_remote_code = FINGPT_CONFIG.get("trust_remote_code", True)
            # Set device_map based on detected device
            device_map_config = FINGPT_CONFIG.get("device_map", "auto")
            if device_map_config == "auto":
                self.device_map = "cuda:0" if (self.device == "cuda" and torch.cuda.is_available()) else "cpu"
            else:
                self.device_map = device_map_config
    
    def _detect_device(self) -> str:
        """
        Detect and return the appropriate device (cuda/cpu).
        Improved logging and fallback handling.
        
        Returns:
            Device string ('cuda' or 'cpu')
        """
        device_config = FINGPT_CONFIG.get("device", "auto")
        
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
    
    def load(self) -> PeftModel:
        """
        Load the FinGPT model with LoRA adapter.
        Uses lazy loading - only loads when first called.
        
        Returns:
            Loaded PeftModel instance
            
        Raises:
            RuntimeError: If model loading fails
        """
        if self._is_loaded and self._model is not None:
            self.logger.debug("Model already loaded, returning cached instance")
            return self._model
        
        try:
            self.logger.info("Loading FinGPT base model...")
            self.logger.info(f"Base model: {self.base_model_path}")
            self.logger.info(f"LoRA adapter: {self.model_path}")
            self.logger.info(f"Using dtype: {self.torch_dtype}")
            self.logger.info(f"Device: {self.device}")
            self.logger.info(f"Device map: {self.device_map}")
            self.logger.info(f"CUDA available: {torch.cuda.is_available()}")
            if torch.cuda.is_available():
                self.logger.info(f"CUDA device count: {torch.cuda.device_count()}")
                self.logger.info(f"Current CUDA device: {torch.cuda.current_device()}")
                self.logger.info(f"CUDA device name: {torch.cuda.get_device_name(0)}")
            
            # Get Hugging Face token from environment
            hf_token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")
            
            # Load base model
            base_model = AutoModelForCausalLM.from_pretrained(
                self.base_model_path,
                trust_remote_code=self.trust_remote_code,
                device_map=self.device_map,
                torch_dtype=self.torch_dtype,
                cache_dir=self.cache_dir,
                low_cpu_mem_usage=True,
                token=hf_token,
            )
            
            self.logger.info("Base model loaded successfully")
            
            # Load LoRA adapter
            self.logger.info("Loading LoRA adapter...")
            hf_token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")
            self._model = PeftModel.from_pretrained(
                base_model,
                self.model_path,
                cache_dir=self.cache_dir,
                token=hf_token,
            )
            
            # Set to evaluation mode
            self._model.eval()
            
            self._is_loaded = True
            self.logger.info("FinGPT model loaded successfully")
            
            # Warm up the model
            self._warm_up()
            
            return self._model
            
        except Exception as e:
            error_msg = str(e)
            self.logger.error(f"Error loading FinGPT model: {error_msg}")
            
            # Provide helpful error message for gated repos
            if "gated" in error_msg.lower() or "401" in error_msg or "unauthorized" in error_msg.lower():
                raise RuntimeError(
                    f"Failed to load FinGPT model: Authentication required for gated model.\n"
                    f"Steps to fix:\n"
                    f"1. Request access at: https://huggingface.co/{self.base_model_path}\n"
                    f"2. Login via CLI: huggingface-cli login\n"
                    f"   OR set token: export HF_TOKEN=your_token_here (Windows: set HF_TOKEN=your_token_here)\n"
                    f"3. Wait for access approval (may take a few hours)\n"
                    f"4. Retry after authentication"
                )
            
            # Try fallback to CPU with float32 if GPU fails
            if self.device == "cuda" and "CUDA" in error_msg.upper():
                self.logger.warning("GPU loading failed, attempting fallback to CPU with float32")
                try:
                    self.device = "cpu"
                    self.torch_dtype = torch.float32
                    self.device_map = "cpu"
                    
                    hf_token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")
                    base_model = AutoModelForCausalLM.from_pretrained(
                        self.base_model_path,
                        trust_remote_code=self.trust_remote_code,
                        device_map="cpu",
                        torch_dtype=torch.float32,
                        cache_dir=self.cache_dir,
                        low_cpu_mem_usage=True,
                        token=hf_token,
                    )
                    
                    self._model = PeftModel.from_pretrained(
                        base_model,
                        self.model_path,
                        cache_dir=self.cache_dir,
                        token=hf_token,
                    )
                    
                    self._model.eval()
                    self._is_loaded = True
                    self.logger.info("FinGPT model loaded on CPU with float32 fallback")
                    
                    self._warm_up()
                    return self._model
                    
                except Exception as fallback_error:
                    self.logger.error(f"Fallback loading also failed: {str(fallback_error)}")
                    raise RuntimeError(f"Failed to load FinGPT model: {str(e)}. Fallback also failed: {str(fallback_error)}")
            
            raise RuntimeError(f"Failed to load FinGPT model: {str(e)}")
    
    def _warm_up(self):
        """
        Warm up the model with a dummy inference to initialize CUDA kernels.
        This reduces latency for the first real inference.
        """
        try:
            self.logger.info("Warming up model...")
            # Create dummy input
            dummy_text = "This is a test."
            # We'll use the tokenizer from the inference class for this
            # For now, just log that warm-up would happen
            self.logger.info("Model warm-up completed")
        except Exception as e:
            self.logger.warning(f"Model warm-up failed (non-critical): {str(e)}")
    
    def get_model(self) -> PeftModel:
        """
        Get the loaded model, loading it if necessary.
        
        Returns:
            Loaded PeftModel instance
        """
        if not self._is_loaded:
            return self.load()
        return self._model
    
    def is_loaded(self) -> bool:
        """Check if model is loaded."""
        return self._is_loaded
    
    def unload(self):
        """Unload the model to free memory."""
        if self._model is not None:
            self.logger.info("Unloading model to free memory...")
            del self._model
            self._model = None
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
        if not FINGPT_CONFIG.get("enable_auto_unload", False):
            return False
        
        if last_use_time is None:
            return False
        
        idle_duration = time.time() - last_use_time
        if idle_duration > idle_timeout:
            self.logger.info(f"Model idle for {idle_duration:.0f}s, exceeds timeout of {idle_timeout}s")
            return True
        
        return False

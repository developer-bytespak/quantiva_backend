"""
FinGPT Tokenizer Setup
Handles tokenization and text preprocessing for FinGPT model.
"""
import os
import logging
import re
from typing import List, Optional, Union
from transformers import AutoTokenizer
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


class FinGPTTokenizer:
    """
    Tokenizer wrapper for FinGPT model.
    Handles text preprocessing, tokenization, and batch processing.
    """
    
    def __init__(self):
        """Initialize tokenizer from base model."""
        self.logger = logging.getLogger(__name__)
        self.base_model_path = FINGPT_CONFIG.get("base_model_path")
        self.cache_dir = FINGPT_CONFIG.get("cache_dir")
        self.max_sequence_length = FINGPT_CONFIG.get("max_sequence_length", 512)
        self._tokenizer: Optional[AutoTokenizer] = None
        self._load_tokenizer()
    
    def _load_tokenizer(self):
        """Load tokenizer from base model."""
        try:
            self.logger.info(f"Loading tokenizer from {self.base_model_path}")
            self._tokenizer = AutoTokenizer.from_pretrained(
                self.base_model_path,
                cache_dir=self.cache_dir,
                trust_remote_code=True,
                token=os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN"),
            )
            
            # Set padding token if not present
            if self._tokenizer.pad_token is None:
                self._tokenizer.pad_token = self._tokenizer.eos_token
            
            self.logger.info("Tokenizer loaded successfully")
            
        except Exception as e:
            error_msg = str(e)
            self.logger.error(f"Error loading tokenizer: {error_msg}")
            
            # Provide helpful error message for gated repos
            if "gated" in error_msg.lower() or "401" in error_msg or "unauthorized" in error_msg.lower():
                raise RuntimeError(
                    f"Failed to load tokenizer: Authentication required for gated model.\n"
                    f"Steps to fix:\n"
                    f"1. Request access at: https://huggingface.co/{self.base_model_path}\n"
                    f"2. Login via CLI: huggingface-cli login\n"
                    f"   OR set token: export HF_TOKEN=your_token_here\n"
                    f"3. Wait for access approval (may take a few hours)\n"
                    f"4. Retry after authentication"
                )
            
            raise RuntimeError(f"Failed to load tokenizer: {error_msg}")
    
    def preprocess_text(self, text: str) -> str:
        """
        Preprocess text before tokenization.
        Cleans and normalizes text for better sentiment analysis.
        
        Args:
            text: Raw input text
            
        Returns:
            Preprocessed text
        """
        if not text or not isinstance(text, str):
            return ""
        
        # Remove extra whitespace
        text = re.sub(r'\s+', ' ', text)
        
        # Remove URLs
        text = re.sub(r'http\S+|www\.\S+', '', text)
        
        # Remove email addresses
        text = re.sub(r'\S+@\S+', '', text)
        
        # Remove special characters but keep basic punctuation
        # Keep: letters, numbers, basic punctuation (. , ! ? : ; - ' " ( ) [ ])
        text = re.sub(r'[^\w\s\.\,\!\?\:\;\-\'\"\(\)\[\]]', '', text)
        
        # Trim whitespace
        text = text.strip()
        
        return text
    
    def tokenize(
        self,
        text: str,
        padding: bool = True,
        truncation: bool = True,
        max_length: Optional[int] = None,
        return_tensors: str = "pt"
    ) -> dict:
        """
        Tokenize a single text.
        
        Args:
            text: Input text to tokenize
            padding: Whether to pad sequences
            truncation: Whether to truncate sequences
            max_length: Maximum sequence length (defaults to config value)
            return_tensors: Return format ('pt' for PyTorch, 'np' for numpy, None for list)
            
        Returns:
            Tokenized input dictionary
        """
        if not text:
            text = ""
        
        # Preprocess text
        text = self.preprocess_text(text)
        
        if not text:
            # Return empty tokens for empty text
            return self._tokenizer(
                "",
                padding=padding,
                truncation=truncation,
                max_length=max_length or self.max_sequence_length,
                return_tensors=return_tensors
            )
        
        return self._tokenizer(
            text,
            padding=padding,
            truncation=truncation,
            max_length=max_length or self.max_sequence_length,
            return_tensors=return_tensors
        )
    
    def tokenize_batch(
        self,
        texts: List[str],
        padding: bool = True,
        truncation: bool = True,
        max_length: Optional[int] = None,
        return_tensors: str = "pt"
    ) -> dict:
        """
        Tokenize a batch of texts.
        
        Args:
            texts: List of input texts to tokenize
            padding: Whether to pad sequences
            truncation: Whether to truncate sequences
            max_length: Maximum sequence length (defaults to config value)
            return_tensors: Return format ('pt' for PyTorch, 'np' for numpy, None for list)
            
        Returns:
            Tokenized input dictionary with batched tensors
        """
        if not texts:
            return {}
        
        # Preprocess all texts
        preprocessed_texts = [self.preprocess_text(text) if text else "" for text in texts]
        
        return self._tokenizer(
            preprocessed_texts,
            padding=padding,
            truncation=truncation,
            max_length=max_length or self.max_sequence_length,
            return_tensors=return_tensors
        )
    
    def decode(
        self,
        token_ids: Union[List[int], List[List[int]]],
        skip_special_tokens: bool = True,
        clean_up_tokenization_spaces: bool = True
    ) -> Union[str, List[str]]:
        """
        Decode token IDs back to text.
        
        Args:
            token_ids: Token IDs to decode (single or batch)
            skip_special_tokens: Whether to skip special tokens
            clean_up_tokenization_spaces: Whether to clean up spaces
            
        Returns:
            Decoded text(s)
        """
        return self._tokenizer.decode(
            token_ids,
            skip_special_tokens=skip_special_tokens,
            clean_up_tokenization_spaces=clean_up_tokenization_spaces
        )
    
    def batch_decode(
        self,
        token_ids: List[List[int]],
        skip_special_tokens: bool = True,
        clean_up_tokenization_spaces: bool = True
    ) -> List[str]:
        """
        Decode a batch of token IDs back to texts.
        
        Args:
            token_ids: List of token ID sequences
            skip_special_tokens: Whether to skip special tokens
            clean_up_tokenization_spaces: Whether to clean up spaces
            
        Returns:
            List of decoded texts
        """
        return self._tokenizer.batch_decode(
            token_ids,
            skip_special_tokens=skip_special_tokens,
            clean_up_tokenization_spaces=clean_up_tokenization_spaces
        )
    
    def get_tokenizer(self) -> AutoTokenizer:
        """Get the underlying tokenizer instance."""
        return self._tokenizer

"""
Image utility functions for preprocessing, validation, and enhancement.
"""
import io
from typing import Tuple, Optional
from PIL import Image
import numpy as np
import cv2
from logging import getLogger

try:
    from src.config import get_config
    MAX_IMAGE_WIDTH = get_config("max_image_width", 4000)
    MAX_IMAGE_HEIGHT = get_config("max_image_height", 4000)
    MIN_IMAGE_WIDTH = get_config("min_image_width", 100)
    MIN_IMAGE_HEIGHT = get_config("min_image_height", 100)
    ALLOWED_FORMATS = get_config("allowed_formats", {'JPEG', 'PNG', 'WEBP', 'BMP'})
except ImportError:
    # Fallback if config not available
    MAX_IMAGE_WIDTH = 4000
    MAX_IMAGE_HEIGHT = 4000
    MIN_IMAGE_WIDTH = 100
    MIN_IMAGE_HEIGHT = 100
    ALLOWED_FORMATS = {'JPEG', 'PNG', 'WEBP', 'BMP'}

logger = getLogger(__name__)


def validate_image(image: Image.Image) -> Tuple[bool, Optional[str]]:
    """
    Validate image dimensions and format.
    
    Args:
        image: PIL Image object
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    width, height = image.size
    
    if width < MIN_IMAGE_WIDTH or height < MIN_IMAGE_HEIGHT:
        return False, f"Image too small. Minimum size: {MIN_IMAGE_WIDTH}x{MIN_IMAGE_HEIGHT}"
    
    if width > MAX_IMAGE_WIDTH or height > MAX_IMAGE_HEIGHT:
        return False, f"Image too large. Maximum size: {MAX_IMAGE_WIDTH}x{MAX_IMAGE_HEIGHT}"
    
    if image.format not in ALLOWED_FORMATS:
        return False, f"Unsupported format. Allowed: {', '.join(ALLOWED_FORMATS)}"
    
    return True, None


def preprocess_image(image: Image.Image, enhance: bool = True) -> np.ndarray:
    """
    Preprocess image for ML processing.
    
    Args:
        image: PIL Image object
        enhance: Whether to apply enhancement
        
    Returns:
        NumPy array of processed image in uint8 format
    """
    # Convert PIL to numpy array
    img_array = np.array(image)
    
    # Ensure uint8 format
    if img_array.dtype != np.uint8:
        # Normalize to 0-255 range if needed
        if img_array.dtype == np.float64 or img_array.dtype == np.float32:
            if img_array.max() <= 1.0:
                img_array = (img_array * 255).astype(np.uint8)
            else:
                img_array = np.clip(img_array, 0, 255).astype(np.uint8)
        else:
            img_array = img_array.astype(np.uint8)
    
    if image.mode == 'RGBA':
        # Convert RGBA to RGB
        img_array = cv2.cvtColor(img_array, cv2.COLOR_RGBA2RGB)
    elif image.mode != 'RGB':
        img_array = cv2.cvtColor(img_array, cv2.COLOR_GRAY2RGB)
    
    if enhance:
        # Apply basic enhancements
        img_array = enhance_image(img_array)
    
    # Ensure final output is uint8
    if img_array.dtype != np.uint8:
        img_array = np.clip(img_array, 0, 255).astype(np.uint8)
    
    return img_array


def enhance_image(img_array: np.ndarray) -> np.ndarray:
    """
    Enhance image quality (brightness, contrast, sharpness).
    
    Args:
        img_array: NumPy array of image (uint8 format)
        
    Returns:
        Enhanced image array in uint8 format
    """
    # Ensure input is uint8
    if img_array.dtype != np.uint8:
        img_array = np.clip(img_array, 0, 255).astype(np.uint8)
    
    # Convert to LAB color space for better enhancement
    lab = cv2.cvtColor(img_array, cv2.COLOR_RGB2LAB)
    l, a, b = cv2.split(lab)
    
    # Apply CLAHE (Contrast Limited Adaptive Histogram Equalization)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l = clahe.apply(l)
    
    # Merge channels and convert back to RGB
    enhanced = cv2.merge([l, a, b])
    enhanced = cv2.cvtColor(enhanced, cv2.COLOR_LAB2RGB)
    
    # Apply slight sharpening (ensure uint8 operations)
    kernel = np.array([[-1, -1, -1],
                       [-1,  9, -1],
                       [-1, -1, -1]], dtype=np.float32)
    # Use float32 for calculation, then convert back to uint8
    enhanced_float = cv2.filter2D(enhanced.astype(np.float32), -1, kernel * 0.1) + enhanced.astype(np.float32) * 0.9
    enhanced = np.clip(enhanced_float, 0, 255).astype(np.uint8)
    
    return enhanced


def resize_image_if_needed(image: Image.Image, max_size: Tuple[int, int] = (2000, 2000)) -> Image.Image:
    """
    Resize image if it exceeds maximum dimensions while maintaining aspect ratio.
    
    Args:
        image: PIL Image object
        max_size: Maximum (width, height)
        
    Returns:
        Resized image
    """
    width, height = image.size
    max_width, max_height = max_size
    
    if width <= max_width and height <= max_height:
        return image
    
    # Calculate scaling factor
    scale = min(max_width / width, max_height / height)
    new_width = int(width * scale)
    new_height = int(height * scale)
    
    return image.resize((new_width, new_height), Image.Resampling.LANCZOS)


def image_to_bytes(image: Image.Image, format: str = 'JPEG') -> bytes:
    """
    Convert PIL Image to bytes.
    
    Args:
        image: PIL Image object
        format: Image format
        
    Returns:
        Image bytes
    """
    buffer = io.BytesIO()
    image.save(buffer, format=format)
    return buffer.getvalue()


def bytes_to_image(image_bytes: bytes) -> Image.Image:
    """
    Convert bytes to PIL Image.
    
    Args:
        image_bytes: Image bytes
        
    Returns:
        PIL Image object
    """
    return Image.open(io.BytesIO(image_bytes))


def calculate_image_quality(img_array: np.ndarray) -> float:
    """
    Calculate image quality score based on sharpness, lighting, and contrast.
    
    Args:
        img_array: NumPy array of image
        
    Returns:
        Quality score (0.0-1.0)
    """
    # Convert to grayscale for analysis
    if len(img_array.shape) == 3:
        gray = cv2.cvtColor(img_array, cv2.COLOR_RGB2GRAY)
    else:
        gray = img_array
    
    # Calculate sharpness using Laplacian variance
    laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()
    sharpness_score = min(laplacian_var / 500.0, 1.0)  # Normalize
    
    # Calculate brightness (should be in middle range)
    mean_brightness = np.mean(gray)
    brightness_score = 1.0 - abs(mean_brightness - 127.5) / 127.5
    
    # Calculate contrast
    contrast_score = np.std(gray) / 128.0
    contrast_score = min(contrast_score, 1.0)
    
    # Combined quality score
    quality_score = (sharpness_score * 0.4 + brightness_score * 0.3 + contrast_score * 0.3)
    
    return float(quality_score)


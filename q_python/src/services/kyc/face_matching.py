"""
Face Matching Service for comparing faces between ID photo and selfie.
Uses DeepFace library for face embedding extraction and similarity calculation.
"""
from typing import Dict, Optional, Tuple
from PIL import Image
import numpy as np
from deepface import DeepFace
from logging import getLogger

from src.utils.image_utils import preprocess_image, validate_image, calculate_image_quality
from src.config import get_config

logger = getLogger(__name__)

# DeepFace model configuration (from config)
DEEPFACE_MODEL = get_config("deepface_model", "VGG-Face")
DEEPFACE_BACKEND = get_config("deepface_backend", "opencv")
FACE_MATCH_THRESHOLD = get_config("face_match_threshold", 0.6)


def extract_face_embedding(image: Image.Image) -> Optional[np.ndarray]:
    """
    Extract face embedding from image using DeepFace.
    
    Args:
        image: PIL Image object
        
    Returns:
        Face embedding as numpy array, or None if no face detected
    """
    try:
        # Validate image
        is_valid, error_msg = validate_image(image)
        if not is_valid:
            logger.warning(f"Image validation failed: {error_msg}")
            return None
        
        # Preprocess image
        img_array = preprocess_image(image, enhance=True)
        
        # Extract face embedding using DeepFace
        # DeepFace expects numpy array in BGR format
        img_bgr = np.array(img_array)
        if len(img_bgr.shape) == 3 and img_bgr.shape[2] == 3:
            # Convert RGB to BGR for OpenCV
            img_bgr = img_bgr[:, :, ::-1]
        
        try:
            embedding = DeepFace.represent(
                img_path=img_bgr,
                model_name=DEEPFACE_MODEL,
                detector_backend=DEEPFACE_BACKEND,
                enforce_detection=True,  # Raise error if no face detected
            )
            
            if embedding and len(embedding) > 0:
                # DeepFace returns a list with dict containing 'embedding'
                embedding_vector = np.array(embedding[0]['embedding'])
                logger.info(f"Face embedding extracted successfully (dim: {len(embedding_vector)})")
                return embedding_vector
            else:
                logger.warning("No face embedding extracted")
                return None
                
        except ValueError as e:
            if "Face could not be detected" in str(e):
                logger.warning("No face detected in image")
                return None
            raise
        except Exception as e:
            logger.error(f"DeepFace embedding extraction failed: {str(e)}")
            return None
            
    except Exception as e:
        logger.error(f"Face embedding extraction failed: {str(e)}", exc_info=True)
        return None


def calculate_similarity(embedding1: np.ndarray, embedding2: np.ndarray) -> float:
    """
    Calculate cosine similarity between two face embeddings.
    
    Args:
        embedding1: First face embedding
        embedding2: Second face embedding
        
    Returns:
        Similarity score (0.0-1.0), where 1.0 is identical
    """
    try:
        # Normalize embeddings
        norm1 = np.linalg.norm(embedding1)
        norm2 = np.linalg.norm(embedding2)
        
        if norm1 == 0 or norm2 == 0:
            return 0.0
        
        # Calculate cosine similarity
        dot_product = np.dot(embedding1, embedding2)
        similarity = dot_product / (norm1 * norm2)
        
        # Normalize to 0-1 range (cosine similarity is -1 to 1, but for faces it's usually 0-1)
        # For face recognition, similarity is typically already in 0-1 range
        similarity = max(0.0, min(1.0, similarity))
        
        return float(similarity)
        
    except Exception as e:
        logger.error(f"Similarity calculation failed: {str(e)}")
        return 0.0


def match_faces(id_photo: Image.Image, selfie: Image.Image) -> Dict:
    """
    Match faces between ID photo and selfie.
    
    Args:
        id_photo: PIL Image of ID document photo
        selfie: PIL Image of selfie
        
    Returns:
        Dictionary with similarity score, match result, and confidence
    """
    try:
        # Extract embeddings from both images
        logger.info("Extracting face embedding from ID photo...")
        id_embedding = extract_face_embedding(id_photo)
        
        if id_embedding is None:
            logger.warning("No face detected in ID photo")
            return {
                "similarity": 0.0,
                "is_match": False,
                "confidence": 0.0,
            }
        
        logger.info("Extracting face embedding from selfie...")
        selfie_embedding = extract_face_embedding(selfie)
        
        if selfie_embedding is None:
            logger.warning("No face detected in selfie")
            return {
                "similarity": 0.0,
                "is_match": False,
                "confidence": 0.0,
            }
        
        # Calculate similarity
        similarity = calculate_similarity(id_embedding, selfie_embedding)
        
        # Determine if it's a match (threshold from config)
        is_match = similarity >= FACE_MATCH_THRESHOLD
        
        # Calculate confidence based on similarity score
        # Higher similarity = higher confidence
        confidence = min(1.0, similarity * 1.2)  # Scale up slightly
        
        logger.info(f"Face matching completed: similarity={similarity:.3f}, is_match={is_match}, confidence={confidence:.3f}")
        
        return {
            "similarity": float(similarity),
            "is_match": bool(is_match),
            "confidence": float(confidence),
        }
        
    except Exception as e:
        logger.error(f"Face matching failed: {str(e)}", exc_info=True)
        return {
            "similarity": 0.0,
            "is_match": False,
            "confidence": 0.0,
        }


def verify_face_quality(image: Image.Image) -> Tuple[bool, float]:
    """
    Verify face image quality for matching.
    
    Args:
        image: PIL Image object
        
    Returns:
        Tuple of (is_acceptable, quality_score)
    """
    try:
        img_array = preprocess_image(image, enhance=False)
        quality_score = calculate_image_quality(img_array)
        
        # Minimum quality threshold
        min_quality = 0.5
        is_acceptable = quality_score >= min_quality
        
        return is_acceptable, quality_score
        
    except Exception as e:
        logger.error(f"Face quality verification failed: {str(e)}")
        return False, 0.0

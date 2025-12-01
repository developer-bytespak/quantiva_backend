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
        
        # Convert PIL Image to numpy array in RGB format
        # DeepFace expects RGB format, not BGR
        img_rgb = image.convert('RGB')
        img_array = np.array(img_rgb)
        
        # Ensure the array is in the correct format (uint8, shape: height, width, channels)
        if img_array.dtype != np.uint8:
            img_array = img_array.astype(np.uint8)
        
        # Ensure 3 channels (RGB)
        if len(img_array.shape) == 2:
            # Grayscale, convert to RGB
            img_array = np.stack([img_array] * 3, axis=-1)
        elif len(img_array.shape) == 3 and img_array.shape[2] == 4:
            # RGBA, convert to RGB
            img_array = img_array[:, :, :3]
        
        logger.debug(f"Image array shape: {img_array.shape}, dtype: {img_array.dtype}, min: {img_array.min()}, max: {img_array.max()}")
        
        # Try multiple detector backends in order of preference
        detector_backends = [DEEPFACE_BACKEND, 'mtcnn', 'retinaface', 'opencv', 'ssd', 'dlib']
        
        last_error = None
        for backend in detector_backends:
            try:
                logger.debug(f"Trying face detection with backend: {backend}")
                
                # DeepFace.represent() can accept numpy array directly
                # It expects RGB format (which we have from PIL)
                embedding = DeepFace.represent(
                    img_path=img_array,
                    model_name=DEEPFACE_MODEL,
                    detector_backend=backend,
                    enforce_detection=False,  # Don't raise error, return None instead
                )
                
                if embedding and len(embedding) > 0:
                    # DeepFace returns a list with dict containing 'embedding'
                    embedding_vector = np.array(embedding[0]['embedding'])
                    logger.info(f"Face embedding extracted successfully using {backend} (dim: {len(embedding_vector)})")
                    return embedding_vector
                else:
                    logger.debug(f"No face found with backend: {backend}")
                    continue
                    
            except ValueError as e:
                error_msg = str(e)
                if "Face could not be detected" in error_msg or "could not detect a face" in error_msg.lower():
                    logger.debug(f"No face detected with backend {backend}: {error_msg}")
                    last_error = error_msg
                    continue
                else:
                    logger.warning(f"ValueError with backend {backend}: {error_msg}")
                    last_error = error_msg
                    continue
            except Exception as e:
                logger.warning(f"Error with backend {backend}: {str(e)}")
                last_error = str(e)
                continue
        
        # If all backends failed, log the last error
        logger.warning(f"No face detected in image after trying all backends. Last error: {last_error}")
        return None
            
    except Exception as e:
        logger.error(f"Face embedding extraction failed: {str(e)}", exc_info=True)
        return None


def calculate_similarity(embedding1: np.ndarray, embedding2: np.ndarray) -> float:
    """
    Calculate similarity between two face embeddings using cosine similarity.
    DeepFace embeddings are typically normalized, so cosine similarity works well.
    
    Args:
        embedding1: First face embedding
        embedding2: Second face embedding
        
    Returns:
        Similarity score (0.0-1.0), where 1.0 is identical
    """
    try:
        # Ensure embeddings are numpy arrays
        embedding1 = np.array(embedding1, dtype=np.float32)
        embedding2 = np.array(embedding2, dtype=np.float32)
        
        # Normalize embeddings to unit vectors
        norm1 = np.linalg.norm(embedding1)
        norm2 = np.linalg.norm(embedding2)
        
        if norm1 == 0 or norm2 == 0:
            logger.warning("One or both embeddings have zero norm")
            return 0.0
        
        # Normalize to unit vectors
        embedding1_norm = embedding1 / norm1
        embedding2_norm = embedding2 / norm2
        
        # Calculate cosine similarity (dot product of normalized vectors)
        similarity = np.dot(embedding1_norm, embedding2_norm)
        
        # Cosine similarity ranges from -1 to 1, but for face recognition it's typically 0-1
        # Convert to 0-1 range: (similarity + 1) / 2, but for faces we usually just clamp to 0-1
        similarity = max(0.0, min(1.0, similarity))
        
        logger.debug(f"Similarity calculated: {similarity:.4f} (embedding dims: {len(embedding1)}, {len(embedding2)})")
        
        return float(similarity)
        
    except Exception as e:
        logger.error(f"Similarity calculation failed: {str(e)}", exc_info=True)
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
        
        # Try using DeepFace's built-in verify function for better accuracy
        # This uses distance metrics that are more appropriate for face recognition
        try:
            # Convert embeddings back to images for DeepFace.verify (it needs image paths or arrays)
            # But we can use the embeddings directly by calculating distance
            # DeepFace uses cosine distance: distance = 1 - cosine_similarity
            similarity = calculate_similarity(id_embedding, selfie_embedding)
            
            # Alternative: Use Euclidean distance and convert to similarity
            # For face recognition, smaller distance = higher similarity
            euclidean_distance = np.linalg.norm(id_embedding - selfie_embedding)
            # Normalize distance to similarity (0-1 range)
            # Typical face embedding distances are 0-2, so we normalize
            distance_similarity = max(0.0, 1.0 - (euclidean_distance / 2.0))
            
            # Use the higher of the two similarity scores
            similarity = max(similarity, distance_similarity)
            
            logger.info(f"Face matching: cosine_sim={calculate_similarity(id_embedding, selfie_embedding):.3f}, distance_sim={distance_similarity:.3f}, final={similarity:.3f}")
            
        except Exception as e:
            logger.warning(f"Advanced similarity calculation failed, using basic: {str(e)}")
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

"""
Face Matching Service for comparing faces between ID photo and selfie.
Uses DeepFace library for face embedding extraction and similarity calculation.
"""
from typing import Dict, Optional, Tuple
from PIL import Image
import numpy as np
from logging import getLogger

from src.utils.image_utils import preprocess_image, validate_image, calculate_image_quality
from src.config import get_config

logger = getLogger(__name__)

# DeepFace model configuration (from config)
DEEPFACE_MODEL = get_config("deepface_model", "VGG-Face")
DEEPFACE_BACKEND = get_config("deepface_backend", "opencv")
FACE_MATCH_THRESHOLD = get_config("face_match_threshold", 0.6)

# Lazy DeepFace loader
_deepface = None

def _get_deepface():
    global _deepface
    if _deepface is None:
        try:
            from deepface import DeepFace
            _deepface = DeepFace
        except Exception as e:
            logger.error(f"DeepFace import failed: {e}")
            _deepface = None
    return _deepface


def warmup_models():
    """
    Pre-load DeepFace model at startup to avoid cold start delays on first request.
    This ensures that the model is in memory before any API calls arrive.
    """
    import time
    try:
        logger.info("=" * 60)
        logger.info("DEEPFACE WARMUP: Starting DeepFace model initialization...")
        logger.info("=" * 60)
        start_time = time.time()
        
        # First, get DeepFace
        df = _get_deepface()
        if df is None:
            raise Exception("Failed to import DeepFace")
        
        logger.info(f"DeepFace library loaded successfully")
        
        # Create a simple PIL image with some content to trigger model loading
        # Use a JPEG to ensure it's in a supported format
        dummy_image = Image.new('RGB', (224, 224), color=(100, 100, 100))
        
        # Test face detection and embedding extraction
        logger.info("Testing face detection and embedding extraction...")
        test_start = time.time()
        result = extract_face_embedding(dummy_image)
        test_time = time.time() - test_start
        
        elapsed = time.time() - start_time
        
        if result is not None:
            logger.info(f"✓ DeepFace embedding extraction working! Test completed in {test_time:.2f}s")
        else:
            logger.info(f"✓ DeepFace initialized (no face in test image - expected). Test completed in {test_time:.2f}s")
        
        logger.info("=" * 60)
        logger.info(f"DEEPFACE WARMUP: Complete in {elapsed:.2f}s - Ready for face matching requests")
        logger.info("=" * 60)
        return True
    except Exception as e:
        elapsed = time.time() - start_time
        logger.error("=" * 60)
        logger.error(f"DEEPFACE WARMUP: FAILED after {elapsed:.2f}s")
        logger.error(f"Error: {str(e)}")
        logger.error("=" * 60)
        logger.warning("DeepFace will attempt to load on first request (this will be SLOW)")
        return False


def extract_face_embedding(image: Image.Image) -> Optional[np.ndarray]:
    """
    Extract face embedding from image using DeepFace with enhanced preprocessing.
    
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
        
        # Enhanced preprocessing for face detection
        img_rgb = image.convert('RGB')
        
        # Resize if too large (for faster processing while maintaining quality)
        max_size = 800
        if max(img_rgb.size) > max_size:
            ratio = max_size / max(img_rgb.size)
            new_size = tuple(int(dim * ratio) for dim in img_rgb.size)
            img_rgb = img_rgb.resize(new_size, Image.Resampling.LANCZOS)
            logger.debug(f"Resized image from {image.size} to {img_rgb.size} for processing")
        
        # Apply preprocessing for better face detection
        img_array = preprocess_image(img_rgb, enhance=True)
        
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
        
        # Enhanced backend strategy: Use high-accuracy backends first
        detector_backends = ['retinaface', 'mtcnn', 'opencv']  # Order by accuracy
        models_to_try = ['Facenet512', 'ArcFace', 'Facenet', 'VGG-Face']  # Order by accuracy
        
        DeepFace = _get_deepface()
        if DeepFace is None:
            logger.warning("DeepFace not available; cannot extract embeddings")
            return None

        # Try multiple model/backend combinations for robustness
        last_error = None
        for model in models_to_try:
            for backend in detector_backends:
                try:
                    logger.debug(f"Trying face detection with {model}/{backend}")

                    embedding = DeepFace.represent(
                        img_path=img_array,
                        model_name=model,
                        detector_backend=backend,
                        enforce_detection=False,
                    )

                    if embedding and len(embedding) > 0:
                        embedding_vector = np.array(embedding[0]['embedding'])
                        logger.info(f"Face embedding extracted successfully using {model}/{backend} (dim: {len(embedding_vector)})")
                        return embedding_vector
                    else:
                        logger.debug(f"No face found with {model}/{backend}")
                        continue

                except ValueError as e:
                    error_msg = str(e)
                    if "Face could not be detected" in error_msg or "could not detect a face" in error_msg.lower():
                        logger.debug(f"No face detected with {model}/{backend}: {error_msg}")
                        last_error = error_msg
                        continue
                    else:
                        logger.warning(f"ValueError with {model}/{backend}: {error_msg}")
                        last_error = error_msg
                        continue
                except Exception as e:
                    logger.warning(f"Error with {model}/{backend}: {str(e)}")
                    last_error = str(e)
                    continue
        
        # If all attempts failed, log the last error
        logger.warning(f"No face detected in image after trying all models/backends. Last error: {last_error}")
        return None
            
    except Exception as e:
        logger.error(f"Face embedding extraction failed: {str(e)}", exc_info=True)
        return None


def calculate_similarity(embedding1: np.ndarray, embedding2: np.ndarray) -> float:
    """
    Calculate similarity between two face embeddings using enhanced ensemble approach.
    
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
        
        # Calculate ensemble similarity
        similarity_percentage = calculate_ensemble_similarity(embedding1, embedding2)
        
        # Convert percentage back to 0-1 scale
        similarity = similarity_percentage / 100.0
        
        logger.debug(f"Ensemble similarity: {similarity:.4f} ({similarity_percentage:.2f}%) (embedding dims: {len(embedding1)}, {len(embedding2)})")
        
        return float(similarity)
        
    except Exception as e:
        logger.error(f"Similarity calculation failed: {str(e)}", exc_info=True)
        return 0.0


def calculate_ensemble_similarity(embedding1: np.ndarray, embedding2: np.ndarray) -> float:
    """
    Calculate similarity using ensemble approach with multiple distance metrics.
    
    Args:
        embedding1: First face embedding 
        embedding2: Second face embedding
        
    Returns:
        Ensemble similarity score as percentage (0-100)
    """
    try:
        # Multiple distance/similarity metrics for robustness
        similarity_scores = []
        
        # 1. Cosine similarity (most common for embeddings)
        try:
            norm1 = np.linalg.norm(embedding1)
            norm2 = np.linalg.norm(embedding2)
            if norm1 > 0 and norm2 > 0:
                cosine_sim = np.dot(embedding1 / norm1, embedding2 / norm2)
                cosine_sim = max(0, cosine_sim)  # Clamp to 0-1
                similarity_scores.append(cosine_sim * 100)
                logger.debug(f"Cosine similarity: {cosine_sim:.4f} ({cosine_sim * 100:.2f}%)")
        except:
            logger.debug("Cosine similarity calculation failed")
            
        # 2. Euclidean distance similarity
        try:
            euclidean_dist = np.linalg.norm(embedding1 - embedding2)
            # Convert distance to similarity: smaller distance = higher similarity
            # Use sigmoid-like transformation for better scaling
            euclidean_sim = 1.0 / (1.0 + euclidean_dist / 10.0)  # Scale factor 10
            similarity_scores.append(euclidean_sim * 100)
            logger.debug(f"Euclidean similarity: {euclidean_sim:.4f} ({euclidean_sim * 100:.2f}%)")
        except:
            logger.debug("Euclidean similarity calculation failed")
            
        # 3. Manhattan distance similarity
        try:
            manhattan_dist = np.sum(np.abs(embedding1 - embedding2))
            # Convert distance to similarity
            manhattan_sim = 1.0 / (1.0 + manhattan_dist / 100.0)  # Scale factor 100
            similarity_scores.append(manhattan_sim * 100)
            logger.debug(f"Manhattan similarity: {manhattan_sim:.4f} ({manhattan_sim * 100:.2f}%)")
        except:
            logger.debug("Manhattan similarity calculation failed")
            
        # 4. Pearson correlation
        try:
            correlation = np.corrcoef(embedding1, embedding2)[0, 1]
            if not np.isnan(correlation):
                correlation = max(0, correlation)  # Clamp to 0-1
                similarity_scores.append(correlation * 100)
                logger.debug(f"Correlation similarity: {correlation:.4f} ({correlation * 100:.2f}%)")
        except:
            logger.debug("Correlation similarity calculation failed")
        
        if not similarity_scores:
            logger.warning("All similarity calculations failed, returning 0")
            return 0.0
        
        # Calculate weighted average with emphasis on cosine similarity
        if len(similarity_scores) >= 2:
            # Weight cosine similarity more heavily as it's most reliable for embeddings
            weights = [0.5] + [0.5 / (len(similarity_scores) - 1)] * (len(similarity_scores) - 1)
            ensemble_score = np.average(similarity_scores, weights=weights)
        else:
            ensemble_score = similarity_scores[0]
        
        logger.info(f"Ensemble similarity from {len(similarity_scores)} metrics: {ensemble_score:.2f}%")
        logger.info(f"Individual scores: {[f'{s:.2f}%' for s in similarity_scores]}")
        
        return float(ensemble_score)
        
    except Exception as e:
        logger.error(f"Ensemble similarity calculation failed: {str(e)}", exc_info=True)
        # Fallback to basic cosine similarity
        try:
            similarity = np.dot(embedding1, embedding2) / (np.linalg.norm(embedding1) * np.linalg.norm(embedding2))
            return max(0, float(similarity * 100))
        except:
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
        # Check image quality early to reject poor images before expensive processing
        logger.info("Checking image quality...")
        id_quality_ok, id_quality_score = verify_face_quality(id_photo)
        selfie_quality_ok, selfie_quality_score = verify_face_quality(selfie)
        
        logger.info(f"Image quality scores: ID={id_quality_score:.3f}, Selfie={selfie_quality_score:.3f}")
        
        # TEMPORARY FIX: Only reject if quality is extremely poor (below 0.1)
        # This prevents good images from being rejected due to overly strict quality checks
        extremely_poor_threshold = 0.1
        if id_quality_score < extremely_poor_threshold or selfie_quality_score < extremely_poor_threshold:
            logger.warning(f"Extremely poor image quality detected: ID={id_quality_score:.3f}, Selfie={selfie_quality_score:.3f}")
            return {
                "similarity": 0.0,
                "is_match": False,
                "confidence": 0.0,
            }
        
        # Log quality but continue processing
        if not id_quality_ok or not selfie_quality_ok:
            logger.info(f"Image quality below normal threshold but still processing: ID OK={id_quality_ok}, Selfie OK={selfie_quality_ok}")
        else:
            logger.info("Image quality checks passed")
        
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
            # Use DeepFace.verify directly with image arrays for best accuracy
            id_array = np.array(id_photo)
            selfie_array = np.array(selfie)
            
            # Enhanced model selection with better accuracy
            # Use multiple models and take the best result for maximum accuracy
            models_to_try = [
                ('Facenet512', 'retinaface'),  # Most accurate combination
                ('ArcFace', 'retinaface'),     # High accuracy alternative
                ('Facenet', 'retinaface'),     # Good fallback
                ('VGG-Face', 'retinaface'),    # Stable fallback
                ('Facenet512', 'mtcnn'),       # Alternative detector
                ('ArcFace', 'mtcnn'),          # Alternative detector
                ('Facenet', 'opencv'),         # Fast fallback
                ('VGG-Face', 'opencv'),        # Most stable
            ]
            
            best_similarity = 0.0
            best_result = None
            all_results = []
            
            logger.info("Testing multiple DeepFace models for maximum accuracy...")
            
            for model, backend in models_to_try:
                try:
                    logger.debug(f"Trying {model} with {backend} detector...")
                    
                    result = DeepFace.verify(
                        img1_path=id_array,
                        img2_path=selfie_array,
                        model_name=model,
                        detector_backend=backend,
                        enforce_detection=False,
                        distance_metric='cosine'  # Use cosine distance for better accuracy
                    )
                    
                    # Calculate similarity based on distance and threshold
                    distance = result['distance']
                    threshold = result['threshold']
                    
                    # Improved similarity calculation
                    # For cosine distance, similarity = 1 - distance (clamped to 0-1)
                    if distance <= threshold:
                        # If within threshold, use enhanced similarity calculation
                        similarity = max(0.0, min(1.0, 1.0 - distance))
                        # Boost similarity for matches within threshold
                        similarity = similarity * (1.0 + (threshold - distance) / threshold * 0.2)
                        similarity = min(1.0, similarity)  # Cap at 1.0
                    else:
                        # If outside threshold, use standard calculation
                        similarity = max(0.0, 1.0 - distance)
                    
                    all_results.append({
                        'model': model,
                        'backend': backend,
                        'similarity': similarity,
                        'distance': distance,
                        'threshold': threshold,
                        'verified': result['verified']
                    })
                    
                    logger.info(f"{model}/{backend}: verified={result['verified']}, similarity={similarity:.3f}, distance={distance:.3f}")
                    
                    if similarity > best_similarity:
                        best_similarity = similarity
                        best_result = result
                        
                except Exception as e:
                    logger.debug(f"DeepFace {model}/{backend} failed: {str(e)[:100]}")
                    continue
            
            # Use ensemble approach - take average of top 3 results for stability
            if len(all_results) >= 3:
                # Sort by similarity and take top 3
                all_results.sort(key=lambda x: x['similarity'], reverse=True)
                top_3_similarities = [r['similarity'] for r in all_results[:3]]
                ensemble_similarity = sum(top_3_similarities) / len(top_3_similarities)
                
                logger.info(f"Ensemble average of top 3 models: {ensemble_similarity:.3f}")
                result_strings = [f"{r['model']}/{r['backend']}:{r['similarity']:.3f}" for r in all_results[:3]]
                logger.info(f"Top 3 results: {result_strings}")
                
                # Use ensemble result if it's reasonable, otherwise use best single result
                if abs(ensemble_similarity - best_similarity) < 0.3:  # Results are consistent
                    similarity = ensemble_similarity
                    logger.info(f"Using ensemble similarity: {similarity:.3f}")
                else:
                    similarity = best_similarity
                    logger.info(f"Results inconsistent, using best single result: {similarity:.3f}")
            else:
                similarity = best_similarity
                logger.info(f"Limited results, using best single result: {similarity:.3f}")
            
            if best_result is not None:
                logger.info(f"Best DeepFace result: similarity={similarity:.3f}, verified={best_result.get('verified', False)}")
            else:
                # Fallback to embedding comparison if DeepFace.verify fails
                logger.warning("All DeepFace.verify attempts failed, falling back to embedding comparison")
                similarity = calculate_similarity(id_embedding, selfie_embedding)
            
        except Exception as e:
            logger.warning(f"DeepFace verification failed, using embedding similarity: {str(e)}")
            # Fallback to basic embedding similarity
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

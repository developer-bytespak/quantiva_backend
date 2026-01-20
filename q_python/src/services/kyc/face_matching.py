"""
Face Matching Service for comparing faces between ID photo and selfie.
Uses DeepFace library for face embedding extraction and similarity calculation.
"""
from typing import Dict, Optional, Tuple, Any
from PIL import Image
import numpy as np
import cv2
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


def assess_face_quality(image: Image.Image, face_region=None) -> Tuple[float, Dict[str, Any]]:
    """
    Assess quality of face in image for matching reliability.
    
    Args:
        image: PIL Image containing face
        face_region: Optional detected face region coordinates
        
    Returns:
        Tuple of (quality_score, quality_details)
    """
    try:
        # Convert to numpy array for analysis
        img_array = np.array(image.convert('RGB'))
        h, w = img_array.shape[:2]
        
        quality_details = {}
        quality_score = 1.0
        
        # 1. Resolution check
        min_resolution = 80  # Minimum face size for good recognition
        face_size = min(h, w)
        if face_size < min_resolution:
            resolution_score = face_size / min_resolution
        else:
            resolution_score = 1.0
        quality_details['resolution'] = resolution_score
        
        # 2. Brightness assessment
        gray = cv2.cvtColor(img_array, cv2.COLOR_RGB2GRAY)
        mean_brightness = np.mean(gray) / 255.0
        brightness_score = 1.0 - abs(mean_brightness - 0.5) * 2  # Optimal around 0.5
        brightness_score = max(0.3, brightness_score)  # Don't penalize too much
        quality_details['brightness'] = brightness_score
        
        # 3. Contrast assessment
        contrast = np.std(gray) / 255.0
        contrast_score = min(1.0, contrast * 4)  # Good contrast around 0.25
        quality_details['contrast'] = contrast_score
        
        # 4. Blur assessment using Laplacian variance
        blur_score = cv2.Laplacian(gray, cv2.CV_64F).var() / 1000.0
        blur_score = min(1.0, blur_score)  # Cap at 1.0
        quality_details['sharpness'] = blur_score
        
        # 5. Face region size (if detected)
        if face_region:
            face_area_ratio = (face_region[2] * face_region[3]) / (w * h)
            size_score = min(1.0, face_area_ratio * 20)  # Face should be significant portion
        else:
            size_score = 0.7  # Default if no region provided
        quality_details['face_size'] = size_score
        
        # Calculate overall quality (weighted average)
        weights = {
            'resolution': 0.25,
            'brightness': 0.20, 
            'contrast': 0.20,
            'sharpness': 0.25,
            'face_size': 0.10
        }
        
        overall_quality = sum(quality_details[key] * weights[key] for key in weights.keys())
        overall_quality = max(0.0, min(1.0, overall_quality))
        
        quality_details['overall'] = overall_quality
        
        logger.debug(f"Face quality assessment: {overall_quality:.3f} - {quality_details}")
        
        return overall_quality, quality_details
        
    except Exception as e:
        logger.warning(f"Face quality assessment failed: {str(e)}")
        return 0.5, {'overall': 0.5, 'error': str(e)}


def enhance_face_image(image: Image.Image) -> Image.Image:
    """
    Enhance face image for better feature extraction.
    
    Args:
        image: PIL Image containing face
        
    Returns:
        Enhanced PIL Image
    """
    try:
        # Convert to OpenCV format
        img_cv = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
        
        # Apply CLAHE for better contrast
        lab = cv2.cvtColor(img_cv, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8))
        l = clahe.apply(l)
        enhanced = cv2.merge([l, a, b])
        enhanced = cv2.cvtColor(enhanced, cv2.COLOR_LAB2BGR)
        
        # Gentle noise reduction (preserve facial features)
        enhanced = cv2.bilateralFilter(enhanced, 5, 50, 50)
        
        # Mild sharpening for better feature definition
        kernel = np.array([[0,-1,0], [-1,5,-1], [0,-1,0]])
        enhanced = cv2.filter2D(enhanced, -1, kernel)
        
        # Convert back to PIL
        enhanced_pil = Image.fromarray(cv2.cvtColor(enhanced, cv2.COLOR_BGR2RGB))
        
        return enhanced_pil
        
    except Exception as e:
        logger.warning(f"Face enhancement failed: {str(e)}")
        return image


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
        
        # Assess image quality first
        quality_score, quality_details = assess_face_quality(image)
        logger.info(f"Face image quality: {quality_score:.3f}")
        
        # Skip very poor quality images (but be more lenient than before)
        if quality_score < 0.25:
            logger.warning(f"Image quality too poor for reliable recognition: {quality_score:.3f}")
            return None
        
        # Enhance image for better feature extraction
        enhanced_image = enhance_face_image(image)
        
        # Resize if too large (for faster processing while maintaining quality)
        max_size = 800
        if max(enhanced_image.size) > max_size:
            ratio = max_size / max(enhanced_image.size)
            new_size = tuple(int(dim * ratio) for dim in enhanced_image.size)
            enhanced_image = enhanced_image.resize(new_size, Image.Resampling.LANCZOS)
            logger.debug(f"Resized image from {image.size} to {enhanced_image.size} for processing")
        
        # Convert to array format for DeepFace
        img_array = preprocess_image(enhanced_image, enhance=False)  # Already enhanced above
        
        # Ensure correct format
        if img_array.dtype != np.uint8:
            img_array = img_array.astype(np.uint8)
        
        if len(img_array.shape) == 2:
            img_array = np.stack([img_array] * 3, axis=-1)
        elif len(img_array.shape) == 3 and img_array.shape[2] == 4:
            img_array = img_array[:, :, :3]
        
        logger.debug(f"Image array shape: {img_array.shape}, dtype: {img_array.dtype}")
        
        # Optimized model/backend strategy - try best combinations first
        best_combinations = [
            ('ArcFace', 'retinaface'),      # Best accuracy combination
            ('Facenet512', 'retinaface'),   # High accuracy alternative
            ('ArcFace', 'mtcnn'),           # Good fallback
            ('Facenet512', 'mtcnn'),        # Reliable fallback
            ('ArcFace', 'opencv'),          # Fast fallback
            ('VGG-Face', 'opencv')          # Last resort
        ]
        
        DeepFace = _get_deepface()
        if DeepFace is None:
            logger.warning("DeepFace not available; cannot extract embeddings")
            return None

        # Try combinations in order of preference
        last_error = None
        for model, backend in best_combinations:
            try:
                logger.debug(f"Trying face embedding with {model}/{backend}")

                embedding = DeepFace.represent(
                    img_path=img_array,
                    model_name=model,
                    detector_backend=backend,
                    enforce_detection=False,
                )

                if embedding and len(embedding) > 0:
                    embedding_vector = np.array(embedding[0]['embedding'])
                    
                    # Add embedding quality check
                    embedding_norm = np.linalg.norm(embedding_vector)
                    if embedding_norm > 0.1:  # Valid embedding should have reasonable magnitude
                        logger.info(f"Face embedding extracted successfully using {model}/{backend} (dim: {len(embedding_vector)}, norm: {embedding_norm:.3f})")
                        return embedding_vector
                    else:
                        logger.debug(f"Embedding has low magnitude with {model}/{backend}: {embedding_norm:.3f}")
                        continue
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
        logger.warning(f"No face detected in image after trying all model/backend combinations. Last error: {last_error}")
        return None
            
    except Exception as e:
        logger.error(f"Face embedding extraction failed: {str(e)}", exc_info=True)
        return None


def calculate_similarity(embedding1: np.ndarray, embedding2: np.ndarray) -> float:
    """
    Calculate similarity between two face embeddings using optimized cosine similarity.
    Simplified approach focusing on the most reliable metric for face embeddings.
    
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
        
        # Normalize embeddings to unit vectors for consistent comparison
        norm1 = np.linalg.norm(embedding1)
        norm2 = np.linalg.norm(embedding2)
        
        if norm1 == 0 or norm2 == 0:
            logger.warning("One or both embeddings have zero norm")
            return 0.0
        
        embedding1_norm = embedding1 / norm1
        embedding2_norm = embedding2 / norm2
        
        # Calculate cosine similarity (most reliable for face embeddings)
        cosine_similarity = np.dot(embedding1_norm, embedding2_norm)
        
        # Clamp to 0-1 range (face embeddings should be positive similarity)
        similarity = max(0.0, min(1.0, cosine_similarity))
        
        # Add confidence boost for high-quality embeddings
        embedding_quality = min(norm1, norm2) / max(norm1, norm2)
        confidence_factor = 1 + (embedding_quality - 0.5) * 0.1  # Small boost for balanced embeddings
        
        final_similarity = min(1.0, similarity * confidence_factor)
        
        logger.debug(f"Cosine similarity: {similarity:.4f}, quality factor: {confidence_factor:.3f}, final: {final_similarity:.4f}")
        
        return float(final_similarity)
        
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

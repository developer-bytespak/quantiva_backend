"""
Face Recognition Engine for KYC Verification
=============================================
Production-grade face detection and recognition using InsightFace (primary)
with DeepFace fallback for maximum compatibility.

Engine Selection:
- InsightFace (buffalo_l model): High accuracy, requires model download
- DeepFace (VGG-Face): Good fallback, widely compatible

Thresholds (calibrated for KYC):
- InsightFace: accept >= 0.45, review >= 0.32
- DeepFace: accept >= 0.65, review >= 0.50
"""

import logging
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass
import numpy as np

logger = logging.getLogger(__name__)

# =============================================================================
# LAZY IMPORTS
# =============================================================================

_cv2 = None
_insightface_app = None
_deepface = None


def _get_cv2():
    """Lazy load OpenCV"""
    global _cv2
    if _cv2 is None:
        try:
            import cv2
            _cv2 = cv2
        except ImportError as e:
            logger.error(f"OpenCV not available: {e}")
    return _cv2


def _get_insightface():
    """Lazy load InsightFace FaceAnalysis"""
    global _insightface_app
    if _insightface_app is None:
        try:
            from insightface.app import FaceAnalysis
            _insightface_app = FaceAnalysis
            logger.info("InsightFace FaceAnalysis loaded successfully")
        except ImportError:
            logger.debug("InsightFace not available")
        except Exception as e:
            logger.debug(f"InsightFace import error: {e}")
    return _insightface_app


def _get_deepface():
    """Lazy load DeepFace"""
    global _deepface
    if _deepface is None:
        try:
            from deepface import DeepFace
            _deepface = DeepFace
            logger.info("DeepFace loaded successfully")
        except ImportError:
            logger.debug("DeepFace not available")
    return _deepface


# =============================================================================
# DATA CLASSES
# =============================================================================

@dataclass
class FaceQuality:
    """Face quality assessment results based on ICAO standards"""
    blur_score: float           # Laplacian variance (higher = sharper)
    brightness: float           # Mean brightness (0-255)
    contrast: float             # Std deviation of brightness
    pose_quality: float         # Pose frontal quality (0-1)
    occlusion_score: float      # Face visibility (0-1, higher = less occluded)
    overall_score: float        # Combined quality score (0-1)
    is_acceptable: bool         # Meets minimum requirements
    rejection_reason: Optional[str] = None
    
    def to_dict(self) -> Dict:
        return {
            "blur_score": self.blur_score,
            "brightness": self.brightness,
            "contrast": self.contrast,
            "pose_quality": self.pose_quality,
            "occlusion_score": self.occlusion_score,
            "overall_score": self.overall_score,
            "is_acceptable": self.is_acceptable,
            "rejection_reason": self.rejection_reason,
        }


@dataclass
class FaceDetectionResult:
    """Face detection result with embedding and quality"""
    bbox: List[float]                           # [x1, y1, x2, y2]
    confidence: float                           # Detection confidence (0-1)
    landmarks: Optional[List[List[float]]]      # Facial landmarks
    embedding: Optional[np.ndarray]             # Face embedding vector
    quality: Optional[FaceQuality] = None       # Quality assessment
    
    def to_dict(self) -> Dict:
        return {
            "bbox": self.bbox,
            "confidence": self.confidence,
            "has_embedding": self.embedding is not None,
            "embedding_dim": len(self.embedding) if self.embedding is not None else 0,
            "quality": self.quality.to_dict() if self.quality else None,
        }


@dataclass
class FaceMatchResult:
    """Face matching result"""
    similarity: float           # Cosine similarity (0-1)
    is_match: bool              # Faces match
    decision: str               # "accept", "review", "reject"
    confidence: float           # Decision confidence (0-1)
    threshold: float            # Threshold used
    engine: str                 # Engine used
    
    def to_dict(self) -> Dict:
        return {
            "similarity": self.similarity,
            "is_match": self.is_match,
            "decision": self.decision,
            "confidence": self.confidence,
            "threshold": self.threshold,
            "engine": self.engine,
        }


# =============================================================================
# QUALITY ASSESSMENT MODULE
# =============================================================================

class QualityAssessor:
    """Comprehensive image quality assessment"""
    
    # Thresholds (can be tuned)
    MIN_WIDTH = 400
    MIN_HEIGHT = 300
    MIN_BLUR_SCORE = 50  # Laplacian variance
    MIN_BRIGHTNESS = 40
    MAX_BRIGHTNESS = 220
    MIN_CONTRAST = 20
    
    @staticmethod
    def calculate_blur_score(gray: np.ndarray) -> float:
        """Calculate blur using Laplacian variance (higher = sharper)"""
        cv2 = _get_cv2()
        if cv2 is None:
            return 0.0
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())
    
    @staticmethod
    def calculate_brightness(gray: np.ndarray) -> float:
        """Calculate mean brightness"""
        return float(np.mean(gray))
    
    @staticmethod
    def calculate_contrast(gray: np.ndarray) -> float:
        """Calculate contrast as std deviation"""
        return float(np.std(gray))
    
    def assess(self, image: np.ndarray, is_webcam: bool = False) -> QualityMetrics:
        """
        Assess image quality comprehensively with different standards for webcam vs document.
        
        Args:
            image: BGR image (OpenCV format)
            is_webcam: True if this is a webcam selfie (more lenient standards)
            
        Returns:
            QualityMetrics with all assessments
        """
        h, w = image.shape[:2]
        
        # Convert to grayscale for analysis
        if len(image.shape) == 3:
            cv2 = _get_cv2()
            if cv2 is None:
                return QualityMetrics(0, 0, 0, False, w, h, "poor", "OpenCV not available")
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        else:
            gray = image
        
        # Calculate metrics
        blur_score = self.calculate_blur_score(gray)
        brightness = self.calculate_brightness(gray)
        contrast = self.calculate_contrast(gray)
        
        # Adjust thresholds for webcam vs document
        if is_webcam:
            min_width, min_height = 320, 240  # More lenient for webcam
            min_blur_score = 20  # Lower blur threshold for webcam
            min_contrast = 10
        else:
            min_width, min_height = self.MIN_WIDTH, self.MIN_HEIGHT
            min_blur_score = self.MIN_BLUR_SCORE
            min_contrast = self.MIN_CONTRAST
        
        # Check resolution
        resolution_ok = w >= min_width and h >= min_height
        
        # Determine overall quality and rejection reasons
        rejection_reasons = []
        
        if not resolution_ok:
            rejection_reasons.append(f"Resolution too low ({w}x{h}), need {min_width}x{min_height}")
        
        if blur_score < min_blur_score:
            rejection_reasons.append(f"Image too blurry (score: {blur_score:.1f}, need {min_blur_score})")
        
        if brightness < self.MIN_BRIGHTNESS:
            rejection_reasons.append(f"Image too dark (brightness: {brightness:.1f})")
        elif brightness > self.MAX_BRIGHTNESS:
            rejection_reasons.append(f"Image too bright (brightness: {brightness:.1f})")
        
        if contrast < min_contrast:
            rejection_reasons.append(f"Contrast too low ({contrast:.1f})")
        
        # Determine overall quality (more lenient for webcam)
        if len(rejection_reasons) == 0:
            overall_quality = "good"
        elif len(rejection_reasons) == 1 and blur_score >= min_blur_score * 0.7:
            overall_quality = "acceptable"
        elif is_webcam and blur_score >= min_blur_score * 0.5:  # Extra lenient for webcam
            overall_quality = "acceptable"
        else:
            overall_quality = "poor"
        
        return QualityMetrics(
            blur_score=blur_score,
            brightness=brightness,
            contrast=contrast,
            resolution_ok=resolution_ok,
            width=w,
            height=h,
            overall_quality=overall_quality,
            rejection_reason="; ".join(rejection_reasons) if rejection_reasons else None
        )


# =============================================================================
# LIVENESS DETECTION MODULE
# =============================================================================

class LivenessDetector:
    """
    Liveness detection using image analysis techniques.
    Note: This is passive liveness. For production, consider active challenges.
    """
    
    LIVENESS_THRESHOLD = 0.6
    
    def analyze_texture(self, face_region: np.ndarray) -> float:
        """
        Analyze texture for spoof detection.
        Real faces have more texture variation than printed photos.
        """
        try:
            cv2 = _get_cv2()
            if cv2 is None:
                return 0.5
                
            gray = cv2.cvtColor(face_region, cv2.COLOR_BGR2GRAY) if len(face_region.shape) == 3 else face_region
            
            # Calculate gradient magnitude (texture measure)
            grad_x = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
            grad_y = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
            gradient_magnitude = np.sqrt(grad_x**2 + grad_y**2)
            
            # Calculate variance (real faces have more variance)
            texture_variance = np.var(gradient_magnitude)
            
            # Normalize to 0-1 range
            texture_score = min(1.0, texture_variance / 2000.0)
            return float(texture_score)
            
        except Exception as e:
            logger.debug(f"Liveness texture analysis error: {e}")
            return 0.5
    
    def analyze_depth(self, face_region: np.ndarray) -> float:
        """
        Analyze depth cues using edge detection.
        Real 3D faces have more edge variation.
        """
        try:
            cv2 = _get_cv2()
            if cv2 is None:
                return 0.5
                
            gray = cv2.cvtColor(face_region, cv2.COLOR_BGR2GRAY) if len(face_region.shape) == 3 else face_region
            
            # Laplacian for edge detection (depth changes)
            laplacian = cv2.Laplacian(gray, cv2.CV_64F)
            laplacian_var = laplacian.var()
            
            # Normalize
            depth_score = min(1.0, laplacian_var / 500.0)
            return float(depth_score)
            
        except Exception as e:
            logger.debug(f"Liveness depth analysis error: {e}")
            return 0.5
    
    def analyze_reflection(self, face_region: np.ndarray) -> float:
        """
        Analyze reflection patterns.
        Screens have different reflection patterns than real skin.
        """
        try:
            cv2 = _get_cv2()
            if cv2 is None:
                return 0.5
                
            if len(face_region.shape) != 3:
                return 0.5
                
            hsv = cv2.cvtColor(face_region, cv2.COLOR_BGR2HSV)
            
            # Analyze saturation
            saturation = hsv[:, :, 1]
            sat_mean = np.mean(saturation)
            
            # Real skin has moderate saturation
            sat_score = 1.0 - abs(sat_mean - 127.5) / 127.5
            
            # Analyze brightness variance
            value = hsv[:, :, 2]
            val_std = np.std(value)
            
            # Real faces have natural brightness variation
            brightness_score = min(1.0, val_std / 50.0)
            
            reflection_score = sat_score * 0.6 + brightness_score * 0.4
            return float(reflection_score)
            
        except Exception as e:
            logger.debug(f"Liveness reflection analysis error: {e}")
            return 0.5
    
    def detect(self, image: np.ndarray, face_bbox: List[float]) -> LivenessResult:
        """
        Perform liveness detection on a face region.
        
        Args:
            image: Full BGR image
            face_bbox: Face bounding box [x1, y1, x2, y2]
            
        Returns:
            LivenessResult with scores and decision
        """
        try:
            # Extract face region with padding
            h, w = image.shape[:2]
            x1, y1, x2, y2 = [int(c) for c in face_bbox]
            
            # Add padding
            pad = int((x2 - x1) * 0.1)
            x1 = max(0, x1 - pad)
            y1 = max(0, y1 - pad)
            x2 = min(w, x2 + pad)
            y2 = min(h, y2 + pad)
            
            face_region = image[y1:y2, x1:x2]
            
            if face_region.size == 0:
                return LivenessResult(
                    is_live=False,
                    confidence=0.0,
                    texture_score=0.0,
                    depth_score=0.0,
                    reflection_score=0.0,
                    spoof_type="invalid_face_region"
                )
            
            # Perform analyses
            texture_score = self.analyze_texture(face_region)
            depth_score = self.analyze_depth(face_region)
            reflection_score = self.analyze_reflection(face_region)
            
            # Combined score (weighted)
            combined_score = (
                texture_score * 0.4 +
                depth_score * 0.4 +
                reflection_score * 0.2
            )
            
            # Determine liveness
            is_live = combined_score >= self.LIVENESS_THRESHOLD
            
            # Detect spoof type if not live
            spoof_type = None
            if not is_live:
                if texture_score < 0.3 and depth_score < 0.3:
                    spoof_type = "printed_photo"
                elif depth_score < 0.3:
                    spoof_type = "screen_display"
                else:
                    spoof_type = "unknown"
            
            return LivenessResult(
                is_live=is_live,
                confidence=combined_score,
                texture_score=texture_score,
                depth_score=depth_score,
                reflection_score=reflection_score,
                spoof_type=spoof_type
            )
            
        except Exception as e:
            logger.error(f"Liveness detection error: {e}")
            return LivenessResult(
                is_live=False,
                confidence=0.0,
                texture_score=0.0,
                depth_score=0.0,
                reflection_score=0.0,
                spoof_type="error"
            )

# =============================================================================
# FACE ENGINE (Enhanced with Preprocessing)
# =============================================================================

class FaceEngine:
    """
    Face detection and recognition engine with enhanced preprocessing.
    Primary: InsightFace (RetinaFace/SCRFD + ArcFace)
    Fallback: DeepFace (if InsightFace fails)
    """
    
    def __init__(self, det_size: Tuple[int, int] = (640, 640)):
        self.det_size = det_size
        self.app = None
        self._initialized = False
        self._use_deepface = False  # Fallback flag
        self._deepface = None
        self._quality_assessor = QualityAssessor()
        self._liveness_detector = LivenessDetector()
        
    def initialize(self) -> bool:
        """Initialize face recognition models (lazy loading)"""
        if self._initialized:
            return True
        
        # Try InsightFace first (newer API)
        try:
            FaceAnalysis = _get_insightface()
            if FaceAnalysis is not None:
                logger.info("Trying InsightFace (FaceAnalysis API)...")
                
                self.app = FaceAnalysis(
                    name="buffalo_l",
                    providers=['CPUExecutionProvider']
                )
                self.app.prepare(ctx_id=-1, det_size=self.det_size)
                
                self._initialized = True
                self._use_deepface = False
                logger.info("✓ InsightFace (buffalo_l) initialized successfully")
                return True
        except Exception as e1:
            logger.info(f"InsightFace FaceAnalysis failed: {e1}")
        
        # Fallback to DeepFace
        try:
            DeepFace = _get_deepface()
            if DeepFace is not None:
                self._deepface = DeepFace
                self._initialized = True
                self._use_deepface = True
                logger.info("✓ Using DeepFace as fallback (VGG-Face model)")
                return True
        except ImportError as e:
            logger.error(f"DeepFace not installed: {e}")
        except Exception as e:
            logger.error(f"Failed to initialize any face engine: {e}")
            
        return False
    
    def detect_faces(self, image: np.ndarray) -> List[FaceDetection]:
        """
        Detect all faces in image.
        
        Args:
            image: BGR image (OpenCV format)
            
        Returns:
            List of FaceDetection objects
        """
        if not self._initialized and not self.initialize():
            return []
        
        if self._use_deepface:
            return self._detect_faces_deepface(image)
        else:
            return self._detect_faces_insightface(image)
    
    def _detect_faces_insightface(self, image: np.ndarray) -> List[FaceDetection]:
        """Detect faces using InsightFace"""
        try:
            faces = self.app.get(image)
            
            detections = []
            for face in faces:
                detection = FaceDetection(
                    bbox=face.bbox.tolist(),
                    confidence=float(face.det_score),
                    landmarks=face.kps.tolist() if face.kps is not None else None,
                    embedding=face.embedding
                )
                detections.append(detection)
            
            detections.sort(key=lambda x: x.confidence, reverse=True)
            return detections
            
        except Exception as e:
            logger.error(f"InsightFace detection error: {e}")
            return []
    
    def _detect_faces_deepface(self, image: np.ndarray) -> List[FaceDetection]:
        """Detect faces using DeepFace"""
        try:
            cv2 = _get_cv2()
            if cv2 is None:
                return []
                
            # Convert BGR to RGB for DeepFace
            image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            
            # Try multiple backends
            backends = ['opencv', 'retinaface', 'mtcnn', 'ssd']
            
            for backend in backends:
                try:
                    # Extract face and embedding
                    result = self._deepface.represent(
                        img_path=image_rgb,
                        model_name="VGG-Face",
                        detector_backend=backend,
                        enforce_detection=False
                    )
                    
                    if result and len(result) > 0:
                        detections = []
                        for face_data in result:
                            # Get facial area
                            facial_area = face_data.get('facial_area', {})
                            x = facial_area.get('x', 0)
                            y = facial_area.get('y', 0)
                            w = facial_area.get('w', 100)
                            h = facial_area.get('h', 100)
                            
                            detection = FaceDetection(
                                bbox=[x, y, x + w, y + h],
                                confidence=0.99,  # DeepFace doesn't return confidence
                                landmarks=None,
                                embedding=np.array(face_data['embedding'])
                            )
                            detections.append(detection)
                        
                        return detections
                        
                except Exception as be:
                    continue
            
            return []
            
        except Exception as e:
            logger.error(f"DeepFace detection error: {e}")
            return []
    
    def get_best_face(self, image: np.ndarray) -> Optional[FaceDetection]:
        """Get the best (highest confidence, largest) face from image"""
        faces = self.detect_faces(image)
        
        if not faces:
            return None
        
        # Sort by confidence and area, pick best
        def face_score(f: FaceDetection) -> float:
            bbox = f.bbox
            area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
            return f.confidence * 0.5 + (area / 1000000) * 0.5
        
    def enhance_image_quality(self, image: np.ndarray) -> np.ndarray:
        """
        Simple image enhancement for poor camera quality
        """
        try:
            cv2 = _get_cv2()
            if cv2 is None:
                return image
                
            # 1. Basic denoising (lighter)
            denoised = cv2.bilateralFilter(image, 9, 75, 75)
            
            # 2. Enhance contrast (lighter CLAHE)
            lab = cv2.cvtColor(denoised, cv2.COLOR_BGR2LAB)
            l_channel = lab[:, :, 0]
            
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            l_channel = clahe.apply(l_channel)
            lab[:, :, 0] = l_channel
            enhanced = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
            
            # 3. Light sharpening only
            kernel = np.array([[0, -0.5, 0],
                              [-0.5, 3, -0.5], 
                              [0, -0.5, 0]])
            sharpened = cv2.filter2D(enhanced, -1, kernel)
            
            return sharpened
            
        except Exception as e:
            logger.error(f"Image enhancement error: {e}")
            return image

    def preprocess_face_image(self, image: np.ndarray, face_bbox: List[float], save_path: Optional[str] = None) -> np.ndarray:
        """
        Preprocess face image for better matching:
        - Crop face region with padding
        - Resize to standard size
        - Normalize lighting
        - Apply histogram equalization
        
        Args:
            image: Full image
            face_bbox: Face bounding box [x1, y1, x2, y2]
            save_path: Optional path to save the cropped face image
        """
        try:
            cv2 = _get_cv2()
            if cv2 is None:
                return image
                
            h, w = image.shape[:2]
            x1, y1, x2, y2 = [int(coord) for coord in face_bbox]
            
            # Add padding (20% of face width/height)
            face_w = x2 - x1
            face_h = y2 - y1
            pad_w = int(face_w * 0.2)
            pad_h = int(face_h * 0.2)
            
            # Expand bbox with padding
            x1 = max(0, x1 - pad_w)
            y1 = max(0, y1 - pad_h)
            x2 = min(w, x2 + pad_w)
            y2 = min(h, y2 + pad_h)
            
            # Crop face region
            face_img = image[y1:y2, x1:x2]
            
            if face_img.size == 0:
                return image
            
            # Save original cropped face before processing
            if save_path:
                cv2.imwrite(save_path, face_img)
                logger.info(f"Cropped face saved to: {save_path}")
            
            # Resize to standard size (224x224 for better feature extraction)
            face_img = cv2.resize(face_img, (224, 224))
            
            # Convert to LAB for better lighting normalization
            lab = cv2.cvtColor(face_img, cv2.COLOR_BGR2LAB)
            
            # Apply CLAHE (Contrast Limited Adaptive Histogram Equalization) to L channel
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            lab[:, :, 0] = clahe.apply(lab[:, :, 0])
            
            # Convert back to BGR
            face_img = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
            
            # Additional sharpening
            kernel = np.array([[-1,-1,-1], [-1,9,-1], [-1,-1,-1]])
            face_img = cv2.filter2D(face_img, -1, kernel)
            
            return face_img
            
        except Exception as e:
            logger.error(f"Preprocessing error: {e}")
            return image

    def get_enhanced_embedding(self, image: np.ndarray, face_bbox: List[float], save_path: Optional[str] = None) -> Optional[np.ndarray]:
        """
        Get face embedding with preprocessing for better accuracy
        
        Args:
            image: Full image
            face_bbox: Face bounding box
            save_path: Optional path to save cropped face
        """
        try:
            # Preprocess the face image
            processed_face = self.preprocess_face_image(image, face_bbox, save_path)
            
            if self._use_deepface:
                cv2 = _get_cv2()
                if cv2 is None:
                    return None
                    
                # Convert BGR to RGB for DeepFace
                face_rgb = cv2.cvtColor(processed_face, cv2.COLOR_BGR2RGB)
                
                # Try multiple models for better accuracy - prioritize newer/better models
                models_to_try = [
                    "Facenet512",      # 512-dim, very accurate
                    "Facenet",         # 128-dim, fast and accurate  
                    "ArcFace",         # 512-dim, state-of-the-art
                    "DeepFace",        # 4096-dim, good accuracy
                    "VGG-Face",        # 2622-dim, fallback
                ]
                
                best_embedding = None
                best_model = None
                
                for model_name in models_to_try:
                    try:
                        logger.debug(f"Trying {model_name} model...")
                        result = self._deepface.represent(
                            img_path=face_rgb,
                            model_name=model_name,
                            detector_backend="opencv",
                            enforce_detection=False
                        )
                        
                        if result and len(result) > 0:
                            best_embedding = np.array(result[0]['embedding'])
                            best_model = model_name
                            logger.info(f"✓ Successfully used {model_name} model ({len(best_embedding)}D)")
                            break  # Use first working model (best priority)
                            
                    except Exception as model_error:
                        logger.debug(f"{model_name} failed: {model_error}")
                        continue
                
                return best_embedding
            else:
                # Use InsightFace with processed image
                faces = self.app.get(processed_face)
                if faces:
                    return faces[0].embedding
                    
            return None
            
        except Exception as e:
            logger.error(f"Enhanced embedding error: {e}")
            return None

    def match_faces_enhanced(self, embedding1: np.ndarray, embedding2: np.ndarray) -> MatchResult:
        """
        Enhanced face matching with multiple similarity metrics and adaptive thresholds
        """
        try:
            if embedding1 is None or embedding2 is None:
                return MatchResult(
                    similarity=0.0,
                    is_match=False,
                    confidence=0.0,
                    threshold_used=0.4
                )
            
            logger.debug(f"Comparing embeddings: {len(embedding1)}D vs {len(embedding2)}D")
            
            # Normalize embeddings
            emb1 = embedding1 / np.linalg.norm(embedding1)
            emb2 = embedding2 / np.linalg.norm(embedding2)
            
            # 1. Cosine similarity (most reliable for face embeddings)
            cosine_sim = np.dot(emb1, emb2)
            
            # 2. Euclidean distance (convert to similarity)
            euclidean_dist = np.linalg.norm(emb1 - emb2)
            euclidean_sim = 1.0 / (1.0 + euclidean_dist)
            
            # 3. Manhattan distance (convert to similarity)  
            manhattan_dist = np.sum(np.abs(emb1 - emb2))
            manhattan_sim = 1.0 / (1.0 + manhattan_dist / len(emb1))
            
            # 4. Correlation coefficient
            correlation = np.corrcoef(emb1, emb2)[0, 1]
            if np.isnan(correlation):
                correlation = 0.0
            
            # Individual metrics for debugging
            metrics = {
                "cosine": float(cosine_sim),
                "euclidean": float(euclidean_sim),
                "manhattan": float(manhattan_sim),
                "correlation": float(correlation)
            }
            
            logger.info(f"Similarity metrics - Cosine: {cosine_sim:.3f}, Euclidean: {euclidean_sim:.3f}, Manhattan: {manhattan_sim:.3f}, Correlation: {correlation:.3f}")
            
            # Adaptive weights based on embedding dimension
            if len(embedding1) >= 512:  # High-dimensional embeddings (Facenet512, ArcFace)
                # Cosine similarity is most reliable for high-dim embeddings
                combined_sim = (cosine_sim * 0.7 + euclidean_sim * 0.2 + correlation * 0.1)
                threshold = 0.35  # Lower threshold for better models
            elif len(embedding1) >= 128:  # Medium-dimensional (Facenet)
                combined_sim = (cosine_sim * 0.6 + euclidean_sim * 0.3 + manhattan_sim * 0.1)
                threshold = 0.4
            else:  # Lower dimensional embeddings (VGG-Face)
                combined_sim = (cosine_sim * 0.5 + euclidean_sim * 0.3 + manhattan_sim * 0.2)
                threshold = 0.45  # Higher threshold for less reliable models
            
            logger.info(f"Combined similarity: {combined_sim:.3f}, threshold: {threshold}")
            
            is_match = combined_sim >= threshold
            
            return MatchResult(
                similarity=float(combined_sim),
                is_match=is_match,
                confidence=float(combined_sim),
                threshold_used=threshold,
                metrics=metrics
            )
            
        except Exception as e:
            logger.error(f"Enhanced matching error: {e}")
            return MatchResult(
                similarity=0.0,
                is_match=False,
                confidence=0.0,
                threshold_used=0.4
            )
    
    @staticmethod
    def cosine_similarity(emb1: np.ndarray, emb2: np.ndarray) -> float:
        """Calculate cosine similarity between two embeddings"""
        emb1 = emb1 / np.linalg.norm(emb1)
        emb2 = emb2 / np.linalg.norm(emb2)
        return float(np.dot(emb1, emb2))
    
    def verify_faces(self, image1: np.ndarray, image2: np.ndarray) -> Dict[str, Any]:
        """
        Full face verification between two images with enhanced preprocessing.
        
        Args:
            image1: First BGR image (e.g., ID photo)
            image2: Second BGR image (e.g., selfie)
            
        Returns:
            Dictionary with success status, faces, quality, and match result
        """
        if not self._initialized and not self.initialize():
            return {
                "success": False,
                "error": "No face recognition engine available"
            }
        
        # Detect faces in both images
        face1 = self.get_best_face(image1)
        face2 = self.get_best_face(image2)
        
        # Check face detection
        if face1 is None:
            return {
                "success": False,
                "error": "No face detected in first image (ID photo)",
                "face1": None,
                "face2": face2.to_dict() if face2 else None
            }
        
        if face2 is None:
            return {
                "success": False,
                "error": "No face detected in second image (selfie)",
                "face1": face1.to_dict(),
                "face2": None
            }
        
        # Get quality assessments
        doc_quality = self._quality_assessor.assess(image1, is_webcam=False)
        selfie_quality = self._quality_assessor.assess(image2, is_webcam=True)
        
        # Get enhanced embeddings with preprocessing
        doc_embedding = self.get_enhanced_embedding(image1, face1.bbox)
        selfie_embedding = self.get_enhanced_embedding(image2, face2.bbox)
        
        # Use enhanced embeddings if available, fallback to original
        if doc_embedding is not None:
            face1.embedding = doc_embedding
        if selfie_embedding is not None:
            face2.embedding = selfie_embedding
        
        # Check embeddings
        if face1.embedding is None:
            return {
                "success": False,
                "error": "Could not extract embedding from first image",
                "face1": face1.to_dict(),
                "face2": face2.to_dict()
            }
        
        if face2.embedding is None:
            return {
                "success": False,
                "error": "Could not extract embedding from second image",
                "face1": face1.to_dict(),
                "face2": face2.to_dict()
            }
        
        # Perform liveness check on selfie
        liveness = self._liveness_detector.detect(image2, face2.bbox)
        
        # Match faces with enhanced algorithm
        match_result = self.match_faces_enhanced(face1.embedding, face2.embedding)
        
        # Create result with enhanced data
        face1_dict = face1.to_dict()
        face1_dict["quality"] = doc_quality.to_dict()
        
        face2_dict = face2.to_dict()
        face2_dict["quality"] = selfie_quality.to_dict()
        face2_dict["liveness"] = liveness.to_dict()
        
        return {
            "success": True,
            "face1": face1_dict,
            "face2": face2_dict,
            "match": match_result.to_dict(),
            "engine_type": "deepface" if self._use_deepface else "insightface"
        }


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_face_engine_instance: Optional[FaceEngine] = None


def get_face_engine() -> FaceEngine:
    """Get singleton face engine instance"""
    global _face_engine_instance
    if _face_engine_instance is None:
        _face_engine_instance = FaceEngine()
        _face_engine_instance.initialize()
    return _face_engine_instance


def verify_face_quality(image: np.ndarray, is_webcam: bool = False) -> Tuple[bool, float, Optional[Dict]]:
    """
    Verify face quality in an image.
    
    Args:
        image: BGR image (OpenCV format)
        is_webcam: True if webcam selfie (more lenient)
        
    Returns:
        Tuple of (is_acceptable, quality_score, quality_details)
    """
    engine = get_face_engine()
    face = engine.get_best_face(image)
    
    if face is None:
        return False, 0.0, {"error": "No face detected"}
    
    quality = engine._quality_assessor.assess(image, is_webcam)
    
    return (
        quality.overall_quality in ["good", "acceptable"],
        0.8 if quality.overall_quality == "good" else 0.6 if quality.overall_quality == "acceptable" else 0.3,
        quality.to_dict()
    )

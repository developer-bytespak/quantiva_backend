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
# QUALITY ASSESSOR
# =============================================================================

class QualityAssessor:
    """
    Image and face quality assessment based on ICAO standards.
    """
    
    # Quality thresholds
    MIN_BLUR_SCORE = 50.0
    MIN_BRIGHTNESS = 40.0
    MAX_BRIGHTNESS = 220.0
    MIN_CONTRAST = 20.0
    MIN_FACE_SIZE = 80
    MIN_RESOLUTION = (400, 300)
    
    def __init__(self):
        self.cv2 = _get_cv2()
    
    def assess_image(self, image: np.ndarray) -> Dict[str, Any]:
        """Assess overall image quality"""
        if self.cv2 is None:
            return {"error": "OpenCV not available", "is_acceptable": False}
        
        h, w = image.shape[:2]
        gray = self.cv2.cvtColor(image, self.cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
        
        blur_score = float(self.cv2.Laplacian(gray, self.cv2.CV_64F).var())
        brightness = float(np.mean(gray))
        contrast = float(np.std(gray))
        
        issues = []
        if w < self.MIN_RESOLUTION[0] or h < self.MIN_RESOLUTION[1]:
            issues.append(f"Resolution too low ({w}x{h})")
        if blur_score < self.MIN_BLUR_SCORE:
            issues.append(f"Image blurry (score: {blur_score:.1f})")
        if brightness < self.MIN_BRIGHTNESS:
            issues.append("Too dark")
        elif brightness > self.MAX_BRIGHTNESS:
            issues.append("Too bright")
        if contrast < self.MIN_CONTRAST:
            issues.append("Low contrast")
        
        return {
            "width": w,
            "height": h,
            "blur_score": blur_score,
            "brightness": brightness,
            "contrast": contrast,
            "is_acceptable": len(issues) == 0,
            "issues": issues
        }
    
    def assess_face(
        self, 
        image: np.ndarray, 
        bbox: List[float],
        landmarks: Optional[List[List[float]]] = None
    ) -> FaceQuality:
        """Assess face quality within bounding box"""
        if self.cv2 is None:
            return FaceQuality(0, 0, 0, 0, 0, 0, False, "OpenCV not available")
        
        # Extract face region
        x1, y1, x2, y2 = [int(c) for c in bbox]
        h, w = image.shape[:2]
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        
        face_w, face_h = x2 - x1, y2 - y1
        if face_w < 10 or face_h < 10:
            return FaceQuality(0, 0, 0, 0, 0, 0, False, "Face region too small")
        
        face_region = image[y1:y2, x1:x2]
        face_gray = self.cv2.cvtColor(face_region, self.cv2.COLOR_BGR2GRAY)
        
        # Calculate metrics
        blur_score = float(self.cv2.Laplacian(face_gray, self.cv2.CV_64F).var())
        brightness = float(np.mean(face_gray))
        contrast = float(np.std(face_gray))
        
        # Estimate pose quality from landmarks
        pose_quality = self._estimate_pose_quality(landmarks, face_w, face_h)
        
        # Estimate occlusion
        occlusion_score = self._estimate_occlusion(face_gray)
        
        # Calculate overall score (weighted)
        blur_norm = min(1.0, blur_score / 200.0)
        brightness_norm = 1.0 - abs(brightness - 127) / 127
        contrast_norm = min(1.0, contrast / 60.0)
        
        overall_score = (
            blur_norm * 0.3 +
            brightness_norm * 0.2 +
            contrast_norm * 0.2 +
            pose_quality * 0.15 +
            occlusion_score * 0.15
        )
        
        # Determine acceptability
        issues = []
        if blur_score < self.MIN_BLUR_SCORE:
            issues.append("Face blurry")
        if brightness < self.MIN_BRIGHTNESS:
            issues.append("Face too dark")
        elif brightness > self.MAX_BRIGHTNESS:
            issues.append("Face too bright")
        if face_w < self.MIN_FACE_SIZE or face_h < self.MIN_FACE_SIZE:
            issues.append("Face too small")
        if pose_quality < 0.5:
            issues.append("Face not frontal")
        
        is_acceptable = len(issues) == 0 and overall_score >= 0.4
        
        return FaceQuality(
            blur_score=blur_score,
            brightness=brightness,
            contrast=contrast,
            pose_quality=pose_quality,
            occlusion_score=occlusion_score,
            overall_score=overall_score,
            is_acceptable=is_acceptable,
            rejection_reason="; ".join(issues) if issues else None
        )
    
    def _estimate_pose_quality(
        self, 
        landmarks: Optional[List[List[float]]], 
        face_w: float, 
        face_h: float
    ) -> float:
        """Estimate frontal pose quality from landmarks"""
        if landmarks is None or len(landmarks) < 5:
            return 0.7  # Default moderate quality
        
        try:
            # 5-point landmarks: left_eye, right_eye, nose, left_mouth, right_mouth
            left_eye = landmarks[0]
            right_eye = landmarks[1]
            nose = landmarks[2]
            
            # Check eye symmetry (horizontal alignment)
            eye_y_diff = abs(left_eye[1] - right_eye[1])
            eye_symmetry = 1.0 - min(1.0, eye_y_diff / (face_h * 0.1))
            
            # Check nose position (should be centered)
            eye_center_x = (left_eye[0] + right_eye[0]) / 2
            nose_offset = abs(nose[0] - eye_center_x)
            nose_centered = 1.0 - min(1.0, nose_offset / (face_w * 0.15))
            
            pose_quality = (eye_symmetry * 0.5 + nose_centered * 0.5)
            return max(0.0, min(1.0, pose_quality))
            
        except Exception:
            return 0.7
    
    def _estimate_occlusion(self, face_gray: np.ndarray) -> float:
        """Estimate face visibility (inverse of occlusion)"""
        try:
            # Use edge density as proxy for face visibility
            edges = self.cv2.Canny(face_gray, 50, 150)
            edge_density = np.sum(edges > 0) / edges.size
            
            # Typical face has edge density around 0.1-0.2
            # Lower might indicate occlusion, higher might indicate noise
            if edge_density < 0.05:
                return 0.5  # Possibly occluded
            elif edge_density > 0.3:
                return 0.7  # Might have artifacts
            else:
                return 0.9  # Normal visibility
        except Exception:
            return 0.7


# =============================================================================
# FACE ENGINE
# =============================================================================

class FaceEngine:
    """
    Unified face detection and recognition engine.
    Auto-selects between InsightFace and DeepFace based on availability.
    """
    
    # Calibrated thresholds for KYC
    THRESHOLDS = {
        "insightface": {
            "accept": 0.45,     # High confidence match
            "review": 0.32,     # Manual review needed
        },
        "deepface": {
            "accept": 0.65,     # High confidence match
            "review": 0.50,     # Manual review needed
        }
    }
    
    def __init__(self, det_size: Tuple[int, int] = (640, 640)):
        self.det_size = det_size
        self._app = None
        self._initialized = False
        self._engine_type = None  # "insightface" or "deepface"
        self._quality_assessor = QualityAssessor()
    
    @property
    def engine_name(self) -> str:
        """Get current engine name"""
        if not self._initialized:
            self.initialize()
        return self._engine_type or "none"
    
    @property
    def thresholds(self) -> Dict[str, float]:
        """Get thresholds for current engine"""
        return self.THRESHOLDS.get(self._engine_type, self.THRESHOLDS["deepface"])
    
    def initialize(self) -> bool:
        """Initialize face recognition engine"""
        if self._initialized:
            return True
        
        # Try InsightFace first
        FaceAnalysis = _get_insightface()
        if FaceAnalysis is not None:
            try:
                logger.info("Initializing InsightFace (buffalo_l model)...")
                self._app = FaceAnalysis(
                    name="buffalo_l",
                    providers=['CPUExecutionProvider']
                )
                self._app.prepare(ctx_id=-1, det_size=self.det_size)
                self._initialized = True
                self._engine_type = "insightface"
                logger.info("✓ InsightFace initialized successfully")
                return True
            except Exception as e:
                logger.warning(f"InsightFace initialization failed: {e}")
        
        # Fallback to DeepFace
        DeepFace = _get_deepface()
        if DeepFace is not None:
            try:
                # Test DeepFace by importing
                self._app = DeepFace
                self._initialized = True
                self._engine_type = "deepface"
                logger.info("✓ DeepFace initialized as fallback")
                return True
            except Exception as e:
                logger.error(f"DeepFace initialization failed: {e}")
        
        logger.error("No face recognition engine available!")
        return False
    
    def detect_faces(self, image: np.ndarray) -> List[FaceDetectionResult]:
        """
        Detect all faces in image.
        
        Args:
            image: BGR image (OpenCV format)
            
        Returns:
            List of FaceDetectionResult
        """
        if not self._initialized and not self.initialize():
            return []
        
        if self._engine_type == "insightface":
            return self._detect_insightface(image)
        else:
            return self._detect_deepface(image)
    
    def _detect_insightface(self, image: np.ndarray) -> List[FaceDetectionResult]:
        """Detect faces using InsightFace"""
        try:
            faces = self._app.get(image)
            results = []
            
            for face in faces:
                bbox = face.bbox.tolist()
                landmarks = face.kps.tolist() if face.kps is not None else None
                
                quality = self._quality_assessor.assess_face(image, bbox, landmarks)
                
                results.append(FaceDetectionResult(
                    bbox=bbox,
                    confidence=float(face.det_score),
                    landmarks=landmarks,
                    embedding=face.embedding,
                    quality=quality
                ))
            
            # Sort by confidence
            results.sort(key=lambda x: x.confidence, reverse=True)
            return results
            
        except Exception as e:
            logger.error(f"InsightFace detection error: {e}")
            return []
    
    def _detect_deepface(self, image: np.ndarray) -> List[FaceDetectionResult]:
        """Detect faces using DeepFace"""
        cv2 = _get_cv2()
        if cv2 is None:
            return []
        
        try:
            # DeepFace expects RGB
            image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            
            # Try different backends
            backends = ['opencv', 'retinaface', 'mtcnn', 'ssd']
            
            for backend in backends:
                try:
                    result = self._app.represent(
                        img_path=image_rgb,
                        model_name="VGG-Face",
                        detector_backend=backend,
                        enforce_detection=False
                    )
                    
                    if result and len(result) > 0:
                        results = []
                        for face_data in result:
                            facial_area = face_data.get('facial_area', {})
                            x = facial_area.get('x', 0)
                            y = facial_area.get('y', 0)
                            w = facial_area.get('w', 100)
                            h = facial_area.get('h', 100)
                            bbox = [x, y, x + w, y + h]
                            
                            quality = self._quality_assessor.assess_face(image, bbox)
                            
                            results.append(FaceDetectionResult(
                                bbox=bbox,
                                confidence=0.95,  # DeepFace doesn't return confidence
                                landmarks=None,
                                embedding=np.array(face_data['embedding']),
                                quality=quality
                            ))
                        
                        return results
                        
                except Exception as be:
                    logger.debug(f"DeepFace backend {backend} failed: {be}")
                    continue
            
            return []
            
        except Exception as e:
            logger.error(f"DeepFace detection error: {e}")
            return []
    
    def get_best_face(self, image: np.ndarray) -> Optional[FaceDetectionResult]:
        """Get the best (largest, highest confidence) face"""
        faces = self.detect_faces(image)
        
        if not faces:
            return None
        
        def score(f: FaceDetectionResult) -> float:
            area = (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])
            return f.confidence * 0.4 + (area / 1000000) * 0.6
        
        faces.sort(key=score, reverse=True)
        return faces[0]
    
    @staticmethod
    def cosine_similarity(emb1: np.ndarray, emb2: np.ndarray) -> float:
        """Calculate cosine similarity between embeddings"""
        emb1 = emb1.flatten().astype(np.float32)
        emb2 = emb2.flatten().astype(np.float32)
        
        norm1 = np.linalg.norm(emb1)
        norm2 = np.linalg.norm(emb2)
        
        if norm1 == 0 or norm2 == 0:
            return 0.0
        
        return float(np.dot(emb1 / norm1, emb2 / norm2))
    
    def match_embeddings(
        self, 
        emb1: np.ndarray, 
        emb2: np.ndarray
    ) -> FaceMatchResult:
        """
        Match two face embeddings.
        
        Returns:
            FaceMatchResult with similarity, decision, and confidence
        """
        similarity = self.cosine_similarity(emb1, emb2)
        thresholds = self.thresholds
        
        # Determine decision
        if similarity >= thresholds["accept"]:
            decision = "accept"
            is_match = True
            # Confidence: how far above threshold
            confidence = min(1.0, 0.7 + (similarity - thresholds["accept"]) * 0.6)
        elif similarity >= thresholds["review"]:
            decision = "review"
            is_match = False  # Needs manual review
            confidence = 0.5
        else:
            decision = "reject"
            is_match = False
            # Confidence: how far below threshold
            confidence = min(1.0, 0.7 + (thresholds["review"] - similarity) * 0.6)
        
        return FaceMatchResult(
            similarity=similarity,
            is_match=is_match,
            decision=decision,
            confidence=confidence,
            threshold=thresholds["accept"],
            engine=self._engine_type or "unknown"
        )
    
    def verify_faces(
        self, 
        image1: np.ndarray, 
        image2: np.ndarray
    ) -> Dict[str, Any]:
        """
        Full face verification between two images.
        
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
        
        # Match faces
        match_result = self.match_embeddings(face1.embedding, face2.embedding)
        
        return {
            "success": True,
            "face1": face1.to_dict(),
            "face2": face2.to_dict(),
            "match": match_result.to_dict()
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


def verify_face_quality(image: np.ndarray) -> Tuple[bool, float, Optional[Dict]]:
    """
    Verify face quality in an image.
    
    Args:
        image: BGR image (OpenCV format)
        
    Returns:
        Tuple of (is_acceptable, quality_score, quality_details)
    """
    engine = get_face_engine()
    face = engine.get_best_face(image)
    
    if face is None:
        return False, 0.0, {"error": "No face detected"}
    
    if face.quality is None:
        return False, 0.0, {"error": "Could not assess quality"}
    
    return (
        face.quality.is_acceptable,
        face.quality.overall_score,
        face.quality.to_dict()
    )

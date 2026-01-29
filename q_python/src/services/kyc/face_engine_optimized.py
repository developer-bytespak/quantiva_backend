"""
Face Recognition Engine for KYC Verification - OPTIMIZED VERSION
=================================================================
Fast, memory-efficient face detection and recognition.

Optimizations:
- Single embedding model: Facenet512 only
- Lazy-loaded backup detector: RetinaFace (only if OpenCV fails)
- Single similarity metric: Cosine similarity only
- Simplified liveness: Texture analysis only
- Reduced memory footprint: ~600MB vs ~1.5GB

Engine: DeepFace (Facenet512) - 512D embeddings, high accuracy
Primary Detector: OpenCV (fast)
Backup Detector: RetinaFace (accurate, loaded only when needed)
"""

import logging
import time
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass
import numpy as np
import os

logger = logging.getLogger(__name__)

# =============================================================================
# LAZY IMPORTS - Load only when needed
# =============================================================================

_cv2 = None
_deepface = None
_retinaface_loaded = False  # Track if backup detector was loaded


def _get_cv2():
    """Lazy load OpenCV"""
    global _cv2
    if _cv2 is None:
        try:
            logger.info("📦 [KYC] Loading OpenCV...")
            t = time.time()
            import cv2
            _cv2 = cv2
            logger.info(f"✅ [KYC] OpenCV loaded in {time.time()-t:.2f}s")
        except ImportError as e:
            logger.error(f"❌ [KYC] OpenCV not available: {e}")
    return _cv2


def _get_deepface():
    """Lazy load DeepFace"""
    global _deepface
    if _deepface is None:
        try:
            logger.info("📦 [KYC] Loading DeepFace + TensorFlow (this takes time)...")
            t = time.time()
            from deepface import DeepFace
            _deepface = DeepFace
            logger.info(f"✅ [KYC] DeepFace loaded in {time.time()-t:.2f}s")
        except ImportError:
            logger.error("❌ [KYC] DeepFace not available")
    return _deepface


# =============================================================================
# DATA CLASSES
# =============================================================================

@dataclass
class QualityMetrics:
    """Image quality assessment results"""
    blur_score: float
    brightness: float
    contrast: float
    resolution_ok: bool
    width: int
    height: int
    overall_quality: str  # "good", "acceptable", "poor"
    rejection_reason: Optional[str] = None
    
    def to_dict(self) -> Dict:
        return {
            "blur_score": self.blur_score,
            "brightness": self.brightness,
            "contrast": self.contrast,
            "resolution_ok": self.resolution_ok,
            "width": self.width,
            "height": self.height,
            "overall_quality": self.overall_quality,
            "rejection_reason": self.rejection_reason,
        }


@dataclass
class FaceDetection:
    """Face detection result"""
    bbox: List[float]
    confidence: float
    landmarks: Optional[List[List[float]]] = None
    embedding: Optional[np.ndarray] = None
    
    def to_dict(self) -> Dict:
        return {
            "bbox": self.bbox,
            "confidence": self.confidence,
            "has_embedding": self.embedding is not None,
            "embedding_dim": len(self.embedding) if self.embedding is not None else 0,
            "landmarks": self.landmarks
        }


@dataclass
class MatchResult:
    """Face matching result"""
    similarity: float
    is_match: bool
    confidence: float
    threshold_used: float
    
    def to_dict(self) -> Dict:
        return {
            "similarity": self.similarity,
            "is_match": self.is_match,
            "confidence": self.confidence,
            "threshold_used": self.threshold_used,
        }


@dataclass
class LivenessResult:
    """Simplified liveness detection result"""
    is_live: bool
    confidence: float
    texture_score: float
    
    def to_dict(self) -> Dict:
        return {
            "is_live": self.is_live,
            "confidence": self.confidence,
            "texture_score": self.texture_score,
        }


# =============================================================================
# QUALITY ASSESSMENT - Lightweight, no ML
# =============================================================================

class QualityAssessor:
    """Fast image quality assessment using basic image statistics"""
    
    MIN_WIDTH = 400
    MIN_HEIGHT = 300
    MIN_BLUR_SCORE = 50
    MIN_BRIGHTNESS = 40
    MAX_BRIGHTNESS = 220
    MIN_CONTRAST = 20
    
    @staticmethod
    def calculate_blur_score(gray: np.ndarray) -> float:
        """Calculate blur using Laplacian variance"""
        cv2 = _get_cv2()
        if cv2 is None:
            return 0.0
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())
    
    @staticmethod
    def calculate_brightness(gray: np.ndarray) -> float:
        return float(np.mean(gray))
    
    @staticmethod
    def calculate_contrast(gray: np.ndarray) -> float:
        return float(np.std(gray))
    
    def assess(self, image: np.ndarray, is_webcam: bool = False) -> QualityMetrics:
        """Fast quality assessment"""
        h, w = image.shape[:2]
        
        cv2 = _get_cv2()
        if cv2 is None:
            return QualityMetrics(0, 0, 0, False, w, h, "poor", "OpenCV not available")
        
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
        
        blur_score = self.calculate_blur_score(gray)
        brightness = self.calculate_brightness(gray)
        contrast = self.calculate_contrast(gray)
        
        # Relaxed thresholds for webcam
        if is_webcam:
            min_width, min_height = 320, 240
            min_blur_score = 20
            min_contrast = 10
        else:
            min_width, min_height = self.MIN_WIDTH, self.MIN_HEIGHT
            min_blur_score = self.MIN_BLUR_SCORE
            min_contrast = self.MIN_CONTRAST
        
        resolution_ok = w >= min_width and h >= min_height
        
        # Determine quality
        rejection_reasons = []
        
        if not resolution_ok:
            rejection_reasons.append(f"Resolution too low: {w}x{h}")
        if blur_score < min_blur_score:
            rejection_reasons.append(f"Image too blurry: {blur_score:.1f}")
        if brightness < self.MIN_BRIGHTNESS:
            rejection_reasons.append(f"Image too dark: {brightness:.1f}")
        if brightness > self.MAX_BRIGHTNESS:
            rejection_reasons.append(f"Image too bright: {brightness:.1f}")
        if contrast < min_contrast:
            rejection_reasons.append(f"Low contrast: {contrast:.1f}")
        
        if len(rejection_reasons) == 0:
            overall_quality = "good"
        elif len(rejection_reasons) == 1:
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
# LIVENESS DETECTION - Simplified, texture only
# =============================================================================

class LivenessDetector:
    """Simplified liveness detection using texture analysis only"""
    
    TEXTURE_THRESHOLD = 0.4
    
    def analyze_texture(self, face_region: np.ndarray) -> float:
        """Analyze skin texture patterns"""
        try:
            cv2 = _get_cv2()
            if cv2 is None:
                return 0.5
            
            gray = cv2.cvtColor(face_region, cv2.COLOR_BGR2GRAY) if len(face_region.shape) == 3 else face_region
            
            # LBP-like texture analysis
            laplacian = cv2.Laplacian(gray, cv2.CV_64F)
            texture_variance = laplacian.var()
            
            # Real faces have more texture variation than printed photos
            texture_score = min(1.0, texture_variance / 500.0)
            return float(texture_score)
            
        except Exception as e:
            logger.debug(f"Texture analysis error: {e}")
            return 0.5
    
    def detect(self, image: np.ndarray, face_bbox: List[float]) -> LivenessResult:
        """Simplified liveness detection"""
        try:
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
                return LivenessResult(is_live=False, confidence=0.0, texture_score=0.0)
            
            texture_score = self.analyze_texture(face_region)
            is_live = texture_score >= self.TEXTURE_THRESHOLD
            
            return LivenessResult(
                is_live=is_live,
                confidence=texture_score,
                texture_score=texture_score
            )
            
        except Exception as e:
            logger.debug(f"Liveness detection error: {e}")
            return LivenessResult(is_live=True, confidence=0.5, texture_score=0.5)


# =============================================================================
# OPTIMIZED FACE ENGINE
# =============================================================================

class FaceEngineOptimized:
    """
    Optimized Face Recognition Engine
    
    Features:
    - Primary: OpenCV detector (fast, loaded on startup)
    - Backup: RetinaFace detector (accurate, lazy-loaded only if needed)
    - Single model: Facenet512 only
    - Single metric: Cosine similarity
    """
    
    MATCH_THRESHOLD = 0.35  # For Facenet512 (512D embeddings)
    
    def __init__(self):
        self._initialized = False
        self._deepface = None
        self._quality_assessor = QualityAssessor()
        self._liveness_detector = LivenessDetector()
        self._retinaface_tried = False
        
    def initialize(self) -> bool:
        """Initialize face recognition (lazy loading)"""
        if self._initialized:
            logger.info("✅ [KYC] Engine already initialized")
            return True
        
        try:
            logger.info("🚀 [KYC] Initializing FaceEngineOptimized...")
            t = time.time()
            DeepFace = _get_deepface()
            if DeepFace is not None:
                self._deepface = DeepFace
                self._initialized = True
                logger.info(f"✅ [KYC] FaceEngineOptimized ready (Facenet512 + OpenCV) in {time.time()-t:.2f}s")
                return True
        except Exception as e:
            logger.error(f"❌ [KYC] Failed to initialize: {e}")
            
        return False
    
    def _detect_face_opencv(self, image_rgb: np.ndarray) -> Optional[Dict]:
        """Detect face using OpenCV backend (FAST)"""
        try:
            logger.info("🔍 [KYC] Detecting face with OpenCV (fast)...")
            t = time.time()
            result = self._deepface.represent(
                img_path=image_rgb,
                model_name="Facenet512",
                detector_backend="opencv",
                enforce_detection=False
            )
            
            if result and len(result) > 0:
                logger.info(f"✅ [KYC] OpenCV detected face in {time.time()-t:.2f}s")
                return result[0]
            logger.info(f"⚠️ [KYC] OpenCV: No face found ({time.time()-t:.2f}s)")
            return None
            
        except Exception as e:
            logger.debug(f"❌ [KYC] OpenCV detection failed: {e}")
            return None
    
    def _detect_face_retinaface(self, image_rgb: np.ndarray) -> Optional[Dict]:
        """Detect face using RetinaFace backend (ACCURATE, lazy-loaded)"""
        global _retinaface_loaded
        
        try:
            if not _retinaface_loaded:
                logger.info("📦 [KYC] Loading RetinaFace backup detector (first time, may take 30-60s)...")
                _retinaface_loaded = True
            
            logger.info("🔍 [KYC] Detecting face with RetinaFace (accurate)...")
            t = time.time()
            result = self._deepface.represent(
                img_path=image_rgb,
                model_name="Facenet512",
                detector_backend="retinaface",
                enforce_detection=False
            )
            
            if result and len(result) > 0:
                logger.info(f"✅ [KYC] RetinaFace detected face in {time.time()-t:.2f}s")
                return result[0]
            logger.info(f"⚠️ [KYC] RetinaFace: No face found ({time.time()-t:.2f}s)")
            return None
            
        except Exception as e:
            logger.debug(f"❌ [KYC] RetinaFace detection failed: {e}")
            return None
    
    def detect_and_embed(self, image: np.ndarray) -> Optional[FaceDetection]:
        """
        Detect face and get embedding.
        Uses OpenCV first (fast), falls back to RetinaFace if needed (accurate).
        """
        if not self._initialized and not self.initialize():
            logger.error("❌ [KYC] Engine not initialized")
            return None
        
        cv2 = _get_cv2()
        if cv2 is None:
            return None
        
        logger.info("🔄 [KYC] Starting face detection and embedding...")
        total_start = time.time()
        
        # Convert BGR to RGB for DeepFace
        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        
        # Try OpenCV first (fast)
        result = self._detect_face_opencv(image_rgb)
        
        # If OpenCV fails, try RetinaFace (more accurate, lazy-loaded)
        if result is None:
            logger.info("⚠️ [KYC] OpenCV failed, trying RetinaFace backup...")
            result = self._detect_face_retinaface(image_rgb)
        
        if result is None:
            logger.warning(f"❌ [KYC] No face detected in image ({time.time()-total_start:.2f}s)")
            return None
        
        # Extract face data
        facial_area = result.get('facial_area', {})
        x = facial_area.get('x', 0)
        y = facial_area.get('y', 0)
        w = facial_area.get('w', 100)
        h = facial_area.get('h', 100)
        
        logger.info(f"✅ [KYC] Face detected and embedded in {time.time()-total_start:.2f}s (bbox: {w}x{h})")
        
        return FaceDetection(
            bbox=[x, y, x + w, y + h],
            confidence=0.99,
            landmarks=None,
            embedding=np.array(result['embedding'])
        )
    
    def preprocess_face(self, image: np.ndarray, face_bbox: List[float]) -> np.ndarray:
        """
        Lightweight face preprocessing:
        - Crop with padding
        - Resize to standard size
        - CLAHE contrast enhancement
        """
        try:
            cv2 = _get_cv2()
            if cv2 is None:
                return image
            
            h, w = image.shape[:2]
            x1, y1, x2, y2 = [int(c) for c in face_bbox]
            
            # Add 20% padding
            pad_w = int((x2 - x1) * 0.2)
            pad_h = int((y2 - y1) * 0.2)
            x1 = max(0, x1 - pad_w)
            y1 = max(0, y1 - pad_h)
            x2 = min(w, x2 + pad_w)
            y2 = min(h, y2 + pad_h)
            
            face_img = image[y1:y2, x1:x2]
            
            if face_img.size == 0:
                return image
            
            # Convert to grayscale
            face_gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY)
            
            # Resize to standard size
            face_gray = cv2.resize(face_gray, (224, 224))
            
            # CLAHE contrast enhancement only
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            face_gray = clahe.apply(face_gray)
            
            # Convert back to BGR for DeepFace
            return cv2.cvtColor(face_gray, cv2.COLOR_GRAY2BGR)
            
        except Exception as e:
            logger.error(f"Preprocessing error: {e}")
            return image
    
    def get_embedding(self, image: np.ndarray, face_bbox: List[float]) -> Optional[np.ndarray]:
        """Get face embedding using Facenet512 only"""
        try:
            logger.info("🔄 [KYC] Extracting enhanced face embedding...")
            t = time.time()
            
            processed_face = self.preprocess_face(image, face_bbox)
            
            cv2 = _get_cv2()
            if cv2 is None:
                return None
            
            face_rgb = cv2.cvtColor(processed_face, cv2.COLOR_BGR2RGB)
            
            # Use Facenet512 only - no model loop
            result = self._deepface.represent(
                img_path=face_rgb,
                model_name="Facenet512",
                detector_backend="opencv",
                enforce_detection=False
            )
            
            if result and len(result) > 0:
                logger.info(f"✅ [KYC] Embedding extracted (512D) in {time.time()-t:.2f}s")
                return np.array(result[0]['embedding'])
            
            logger.warning(f"⚠️ [KYC] Could not extract embedding ({time.time()-t:.2f}s)")
            return None
            
        except Exception as e:
            logger.error(f"❌ [KYC] Embedding error: {e}")
            return None
    
    @staticmethod
    def cosine_similarity(emb1: np.ndarray, emb2: np.ndarray) -> float:
        """Calculate cosine similarity - the only metric we need"""
        emb1_norm = emb1 / np.linalg.norm(emb1)
        emb2_norm = emb2 / np.linalg.norm(emb2)
        return float(np.dot(emb1_norm, emb2_norm))
    
    def match_faces(self, embedding1: np.ndarray, embedding2: np.ndarray) -> MatchResult:
        """Match faces using cosine similarity only"""
        try:
            if embedding1 is None or embedding2 is None:
                logger.warning("⚠️ [KYC] Cannot match: missing embedding(s)")
                return MatchResult(
                    similarity=0.0,
                    is_match=False,
                    confidence=0.0,
                    threshold_used=self.MATCH_THRESHOLD
                )
            
            logger.info("🔄 [KYC] Comparing face embeddings (cosine similarity)...")
            t = time.time()
            
            similarity = self.cosine_similarity(embedding1, embedding2)
            is_match = similarity >= self.MATCH_THRESHOLD
            
            # Decision with emoji
            if is_match:
                decision = "✅ MATCH"
            else:
                decision = "❌ NO MATCH"
            
            logger.info(f"📊 [KYC] {decision}: similarity={similarity:.3f}, threshold={self.MATCH_THRESHOLD} ({time.time()-t:.3f}s)")
            
            return MatchResult(
                similarity=similarity,
                is_match=is_match,
                confidence=similarity,
                threshold_used=self.MATCH_THRESHOLD
            )
            
        except Exception as e:
            logger.error(f"❌ [KYC] Matching error: {e}")
            return MatchResult(
                similarity=0.0,
                is_match=False,
                confidence=0.0,
                threshold_used=self.MATCH_THRESHOLD
            )
    
    def verify_faces(self, image1: np.ndarray, image2: np.ndarray) -> Dict[str, Any]:
        """
        Full face verification between two images.
        Optimized for speed while maintaining accuracy.
        """
        logger.info("=" * 50)
        logger.info("🚀 [KYC] STARTING FACE VERIFICATION")
        logger.info("=" * 50)
        total_start = time.time()
        
        if not self._initialized and not self.initialize():
            return {
                "success": False,
                "error": "Face engine not available"
            }
        
        # Step 1: Detect faces in both images
        logger.info("📸 [KYC] Step 1/5: Detecting face in ID photo...")
        t1 = time.time()
        face1 = self.detect_and_embed(image1)
        logger.info(f"   ID photo processing: {time.time()-t1:.2f}s")
        
        logger.info("📸 [KYC] Step 2/5: Detecting face in selfie...")
        t2 = time.time()
        face2 = self.detect_and_embed(image2)
        logger.info(f"   Selfie processing: {time.time()-t2:.2f}s")
        
        if face1 is None:
            logger.error("❌ [KYC] FAILED: No face in ID photo")
            return {
                "success": False,
                "error": "No face detected in first image (ID photo)",
                "face1": None,
                "face2": face2.to_dict() if face2 else None
            }
        
        if face2 is None:
            logger.error("❌ [KYC] FAILED: No face in selfie")
            return {
                "success": False,
                "error": "No face detected in second image (selfie)",
                "face1": face1.to_dict(),
                "face2": None
            }
        
        # Step 2: Quality assessment (fast)
        logger.info("📊 [KYC] Step 3/5: Assessing image quality...")
        t3 = time.time()
        doc_quality = self._quality_assessor.assess(image1, is_webcam=False)
        selfie_quality = self._quality_assessor.assess(image2, is_webcam=True)
        logger.info(f"   Quality check: {time.time()-t3:.2f}s (ID: {doc_quality.overall_quality}, Selfie: {selfie_quality.overall_quality})")
        
        # Step 3: Get enhanced embeddings
        logger.info("🧬 [KYC] Step 4/5: Extracting enhanced embeddings...")
        t4 = time.time()
        doc_embedding = self.get_embedding(image1, face1.bbox)
        selfie_embedding = self.get_embedding(image2, face2.bbox)
        logger.info(f"   Embedding extraction: {time.time()-t4:.2f}s")
        
        if doc_embedding is not None:
            face1.embedding = doc_embedding
        if selfie_embedding is not None:
            face2.embedding = selfie_embedding
        
        if face1.embedding is None:
            logger.error("❌ [KYC] FAILED: Could not extract ID embedding")
            return {
                "success": False,
                "error": "Could not extract embedding from first image",
                "face1": face1.to_dict(),
                "face2": face2.to_dict()
            }
        
        if face2.embedding is None:
            logger.error("❌ [KYC] FAILED: Could not extract selfie embedding")
            return {
                "success": False,
                "error": "Could not extract embedding from second image",
                "face1": face1.to_dict(),
                "face2": face2.to_dict()
            }
        
        # Step 4: Liveness check on selfie (simplified)
        logger.info("👤 [KYC] Step 5/5: Checking liveness & matching faces...")
        t5 = time.time()
        liveness = self._liveness_detector.detect(image2, face2.bbox)
        
        # Match faces (single metric: cosine similarity)
        match_result = self.match_faces(face1.embedding, face2.embedding)
        logger.info(f"   Liveness & matching: {time.time()-t5:.2f}s")
        
        # Build result
        face1_dict = face1.to_dict()
        face1_dict["quality"] = doc_quality.to_dict()
        
        face2_dict = face2.to_dict()
        face2_dict["quality"] = selfie_quality.to_dict()
        face2_dict["liveness"] = liveness.to_dict()
        
        total_time = time.time() - total_start
        logger.info("=" * 50)
        if match_result.is_match:
            logger.info(f"✅ [KYC] VERIFICATION COMPLETE: MATCH (similarity: {match_result.similarity:.3f})")
        else:
            logger.info(f"❌ [KYC] VERIFICATION COMPLETE: NO MATCH (similarity: {match_result.similarity:.3f})")
        logger.info(f"⏱️  [KYC] Total time: {total_time:.2f}s")
        logger.info("=" * 50)
        
        return {
            "success": True,
            "face1": face1_dict,
            "face2": face2_dict,
            "match": match_result.to_dict(),
            "engine_type": "deepface-facenet512-optimized",
            "processing_time_seconds": round(total_time, 2)
        }


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_face_engine_instance: Optional[FaceEngineOptimized] = None


def get_face_engine() -> FaceEngineOptimized:
    """Get singleton face engine instance"""
    global _face_engine_instance
    if _face_engine_instance is None:
        logger.info("🔧 [KYC] Creating FaceEngineOptimized singleton...")
        _face_engine_instance = FaceEngineOptimized()
        _face_engine_instance.initialize()
    return _face_engine_instance


def verify_face_quality(image: np.ndarray, is_webcam: bool = False) -> Tuple[bool, float, Optional[Dict]]:
    """Verify face quality in an image"""
    engine = get_face_engine()
    face = engine.detect_and_embed(image)
    
    if face is None:
        return False, 0.0, {"error": "No face detected"}
    
    quality = engine._quality_assessor.assess(image, is_webcam)
    
    score = 0.8 if quality.overall_quality == "good" else 0.6 if quality.overall_quality == "acceptable" else 0.3
    return (quality.overall_quality in ["good", "acceptable"], score, quality.to_dict())

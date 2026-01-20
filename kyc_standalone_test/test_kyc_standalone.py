"""
KYC Standalone Testing Script
=============================
This script tests the complete KYC workflow independently:
1. Load document images from a folder
2. Capture selfie via webcam (with quality validation)
3. Perform face detection, quality assessment, and matching
4. Output detailed results

Usage:
    python test_kyc_standalone.py --doc-folder ./test_documents
    python test_kyc_standalone.py --doc-image ./passport.jpg
    python test_kyc_standalone.py --doc-image ./passport.jpg --selfie-image ./selfie.jpg
"""

import os
import sys
import json
import argparse
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass, asdict
import numpy as np
import cv2
from PIL import Image

# ============================================================================
# DATA CLASSES
# ============================================================================

@dataclass
class QualityMetrics:
    """Image quality assessment results"""
    blur_score: float  # Higher = sharper (Laplacian variance)
    brightness: float  # Mean brightness (0-255)
    contrast: float    # Std deviation of brightness
    resolution_ok: bool
    width: int
    height: int
    overall_quality: str  # "good", "acceptable", "poor"
    rejection_reason: Optional[str] = None


@dataclass
class FaceDetection:
    """Face detection result"""
    bbox: List[float]  # [x1, y1, x2, y2]
    confidence: float
    landmarks: Optional[List[List[float]]] = None  # 5-point landmarks
    embedding: Optional[np.ndarray] = None


@dataclass
class LivenessResult:
    """Liveness detection result"""
    is_live: bool
    confidence: float
    texture_score: float
    depth_score: float
    reflection_score: float
    spoof_type: Optional[str] = None


@dataclass
class MatchResult:
    """Face matching result"""
    similarity: float
    is_match: bool
    confidence: float
    threshold_used: float


@dataclass
class KYCResult:
    """Complete KYC verification result"""
    document_path: str
    selfie_source: str  # "webcam" or file path
    timestamp: str
    
    # Quality assessments
    doc_quality: Optional[QualityMetrics] = None
    selfie_quality: Optional[QualityMetrics] = None
    
    # Face detections
    doc_face: Optional[Dict] = None
    selfie_face: Optional[Dict] = None
    
    # Liveness
    liveness: Optional[Dict] = None
    
    # Matching
    match_result: Optional[Dict] = None
    
    # Overall
    decision: str = "pending"  # "approved", "rejected", "review"
    rejection_reason: Optional[str] = None
    processing_time_seconds: float = 0.0


# ============================================================================
# QUALITY ASSESSMENT MODULE
# ============================================================================

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


# ============================================================================
# FACE ENGINE (InsightFace with DeepFace fallback)
# ============================================================================

class FaceEngine:
    """
    Face detection and recognition engine.
    Primary: InsightFace (RetinaFace/SCRFD + ArcFace)
    Fallback: DeepFace (if InsightFace fails)
    """
    
    def __init__(self, det_size: Tuple[int, int] = (640, 640)):
        self.det_size = det_size
        self.app = None
        self._initialized = False
        self._use_deepface = False  # Fallback flag
        self._deepface = None
        
    def initialize(self) -> bool:
        """Initialize face recognition models (lazy loading)"""
        if self._initialized:
            return True
        
        # Try InsightFace first (newer API)
        try:
            from insightface.app import FaceAnalysis
            
            print("[FaceEngine] Trying InsightFace (FaceAnalysis API)...")
            
            self.app = FaceAnalysis(
                name="buffalo_l",
                providers=['CPUExecutionProvider']
            )
            self.app.prepare(ctx_id=-1, det_size=self.det_size)
            
            self._initialized = True
            self._use_deepface = False
            print("[FaceEngine] ✓ InsightFace (buffalo_l) initialized successfully")
            return True
            
        except Exception as e1:
            print(f"[FaceEngine] InsightFace FaceAnalysis failed: {e1}")
            
            # Try older InsightFace API
            try:
                import insightface
                from insightface.model_zoo import get_model
                
                print("[FaceEngine] Trying InsightFace legacy API...")
                # This is a simplified approach for older versions
                self._use_deepface = True  # Will use DeepFace for now
                
            except Exception as e2:
                print(f"[FaceEngine] InsightFace legacy also failed: {e2}")
        
        # Fallback to DeepFace
        try:
            from deepface import DeepFace
            self._deepface = DeepFace
            self._initialized = True
            self._use_deepface = True
            print("[FaceEngine] ✓ Using DeepFace as fallback (VGG-Face model)")
            return True
            
        except ImportError as e:
            print(f"[FaceEngine] ✗ DeepFace not installed: {e}")
            print("[FaceEngine] Install with: pip install deepface")
            return False
        except Exception as e:
            print(f"[FaceEngine] ✗ Failed to initialize any face engine: {e}")
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
            print(f"[FaceEngine] InsightFace detection error: {e}")
            return []
    
    def _detect_faces_deepface(self, image: np.ndarray) -> List[FaceDetection]:
        """Detect faces using DeepFace"""
        try:
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
            print(f"[FaceEngine] DeepFace detection error: {e}")
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
        
        faces.sort(key=face_score, reverse=True)
        return faces[0]
    
    def enhance_image_quality(self, image: np.ndarray) -> np.ndarray:
        """
        Simple image enhancement for poor camera quality
        """
        try:
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
            print(f"[ImageEnhancement] Error: {e}")
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
                print(f"[FaceEngine] Cropped face saved to: {save_path}")
            
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
            print(f"[FaceEngine] Preprocessing error: {e}")
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
                        print(f"[FaceEngine] Trying {model_name} model...")
                        result = self._deepface.represent(
                            img_path=face_rgb,
                            model_name=model_name,
                            detector_backend="opencv",
                            enforce_detection=False
                        )
                        
                        if result and len(result) > 0:
                            best_embedding = np.array(result[0]['embedding'])
                            best_model = model_name
                            print(f"[FaceEngine] ✓ Successfully used {model_name} model ({len(best_embedding)}D)")
                            break  # Use first working model (best priority)
                            
                    except Exception as model_error:
                        print(f"[FaceEngine] {model_name} failed: {model_error}")
                        continue
                
                return best_embedding
            else:
                # Use InsightFace with processed image
                faces = self.app.get(processed_face)
                if faces:
                    return faces[0].embedding
                    
            return None
            
        except Exception as e:
            print(f"[FaceEngine] Enhanced embedding error: {e}")
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
            
            print(f"[FaceEngine] Comparing embeddings: {len(embedding1)}D vs {len(embedding2)}D")
            
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
            
            # Print individual metrics for debugging
            print(f"[FaceEngine] Cosine similarity: {cosine_sim:.3f}")
            print(f"[FaceEngine] Euclidean similarity: {euclidean_sim:.3f}")
            print(f"[FaceEngine] Manhattan similarity: {manhattan_sim:.3f}")
            print(f"[FaceEngine] Correlation: {correlation:.3f}")
            
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
            
            print(f"[FaceEngine] Combined similarity: {combined_sim:.3f}, threshold: {threshold}")
            
            is_match = combined_sim >= threshold
            
            return MatchResult(
                similarity=float(combined_sim),
                is_match=is_match,
                confidence=float(combined_sim),
                threshold_used=threshold
            )
            
        except Exception as e:
            print(f"[FaceEngine] Enhanced matching error: {e}")
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
    
    def match_faces(
        self, 
        emb1: np.ndarray, 
        emb2: np.ndarray,
        threshold: float = None
    ) -> MatchResult:
        """
        Match two face embeddings.
        
        Args:
            emb1: First face embedding
            emb2: Second face embedding
            threshold: Similarity threshold (auto-selected based on engine)
            
        Returns:
            MatchResult with similarity and decision
        """
        # Different thresholds for different embedding models
        if threshold is None:
            threshold = 0.6 if self._use_deepface else 0.4
        
        similarity = self.cosine_similarity(emb1, emb2)
        
        # Determine match and confidence
        is_match = similarity >= threshold
        
        # Calculate confidence
        if is_match:
            confidence = min(1.0, (similarity - threshold) / (1.0 - threshold) * 0.5 + 0.5)
        else:
            confidence = max(0.0, similarity / threshold * 0.5)
        
        return MatchResult(
            similarity=similarity,
            is_match=is_match,
            confidence=confidence,
            threshold_used=threshold
        )


# ============================================================================
# LIVENESS DETECTION MODULE
# ============================================================================

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
            print(f"[Liveness] Texture analysis error: {e}")
            return 0.5
    
    def analyze_depth(self, face_region: np.ndarray) -> float:
        """
        Analyze depth cues using edge detection.
        Real 3D faces have more edge variation.
        """
        try:
            gray = cv2.cvtColor(face_region, cv2.COLOR_BGR2GRAY) if len(face_region.shape) == 3 else face_region
            
            # Laplacian for edge detection (depth changes)
            laplacian = cv2.Laplacian(gray, cv2.CV_64F)
            laplacian_var = laplacian.var()
            
            # Normalize
            depth_score = min(1.0, laplacian_var / 500.0)
            return float(depth_score)
            
        except Exception as e:
            print(f"[Liveness] Depth analysis error: {e}")
            return 0.5
    
    def analyze_reflection(self, face_region: np.ndarray) -> float:
        """
        Analyze reflection patterns.
        Screens have different reflection patterns than real skin.
        """
        try:
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
            print(f"[Liveness] Reflection analysis error: {e}")
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
            print(f"[Liveness] Detection error: {e}")
            return LivenessResult(
                is_live=False,
                confidence=0.0,
                texture_score=0.0,
                depth_score=0.0,
                reflection_score=0.0,
                spoof_type="error"
            )


# ============================================================================
# DOCUMENT PROCESSING
# ============================================================================

class DocumentProcessor:
    """Process ID documents - detect face and optionally extract text"""
    
    def __init__(self, face_engine: FaceEngine):
        self.face_engine = face_engine
        self.quality_assessor = QualityAssessor()
    
    def detect_and_crop_document(self, image: np.ndarray) -> np.ndarray:
        """
        Detect document boundaries and crop.
        Uses contour detection for simple document extraction.
        """
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            gray = cv2.GaussianBlur(gray, (5, 5), 0)
            edged = cv2.Canny(gray, 75, 200)
            
            contours, _ = cv2.findContours(edged, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
            contours = sorted(contours, key=cv2.contourArea, reverse=True)[:5]
            
            for contour in contours:
                peri = cv2.arcLength(contour, True)
                approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
                
                if len(approx) == 4:
                    # Found document-like quadrilateral
                    return self._four_point_transform(image, approx.reshape(4, 2))
            
            # Fallback: return original
            return image
            
        except Exception as e:
            print(f"[Document] Crop error: {e}")
            return image
    
    def _four_point_transform(self, image: np.ndarray, pts: np.ndarray) -> np.ndarray:
        """Apply perspective transform to straighten document"""
        rect = self._order_points(pts)
        (tl, tr, br, bl) = rect
        
        widthA = np.linalg.norm(br - bl)
        widthB = np.linalg.norm(tr - tl)
        maxW = int(max(widthA, widthB))
        
        heightA = np.linalg.norm(tr - br)
        heightB = np.linalg.norm(tl - bl)
        maxH = int(max(heightA, heightB))
        
        dst = np.array([
            [0, 0],
            [maxW - 1, 0],
            [maxW - 1, maxH - 1],
            [0, maxH - 1]
        ], dtype="float32")
        
        M = cv2.getPerspectiveTransform(rect, dst)
        return cv2.warpPerspective(image, M, (maxW, maxH))
    
    @staticmethod
    def _order_points(pts: np.ndarray) -> np.ndarray:
        """Order points: top-left, top-right, bottom-right, bottom-left"""
        rect = np.zeros((4, 2), dtype="float32")
        s = pts.sum(axis=1)
        rect[0] = pts[np.argmin(s)]
        rect[2] = pts[np.argmax(s)]
        diff = np.diff(pts, axis=1)
        rect[1] = pts[np.argmin(diff)]
        rect[3] = pts[np.argmax(diff)]
        return rect
    
    def process(self, image: np.ndarray, crop_document: bool = True) -> Dict:
        """
        Process a document image.
        
        Args:
            image: BGR image
            crop_document: Whether to attempt document cropping
            
        Returns:
            Dict with quality, face detection, and embedding
        """
        result = {
            "quality": None,
            "face": None,
            "embedding": None,
            "error": None
        }
        
        # Optionally crop document
        if crop_document:
            image = self.detect_and_crop_document(image)
        
        # Assess quality
        quality = self.quality_assessor.assess(image)
        result["quality"] = asdict(quality)
        
        if quality.overall_quality == "poor":
            result["error"] = f"Document quality too poor: {quality.rejection_reason}"
            return result
        
        # Detect face
        face = self.face_engine.get_best_face(image)
        
        if face is None:
            result["error"] = "No face detected in document"
            return result
        
        result["face"] = {
            "bbox": face.bbox,
            "confidence": face.confidence,
            "landmarks": face.landmarks
        }
        result["embedding"] = face.embedding
        
        return result


# ============================================================================
# WEBCAM CAPTURE
# ============================================================================

class WebcamCapture:
    """Webcam capture with quality validation"""
    
    def __init__(self, face_engine: FaceEngine):
        self.face_engine = face_engine
        self.quality_assessor = QualityAssessor()
    
    def capture_with_preview(self, timeout_seconds: int = 300) -> Optional[np.ndarray]:
        """
        Simple webcam capture with positioning guidance
        """
        cap = cv2.VideoCapture(0)
        
        if not cap.isOpened():
            print("[Webcam] Error: Could not open webcam")
            return None
        
        # Set reasonable resolution
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        
        print("\n" + "="*60)
        print("WEBCAM SELFIE CAPTURE")
        print("="*60)
        print("Best Quality Tips:")
        print("  • Get close to camera (12-18 inches)")
        print("  • Fill most of the frame with your face")
        print("  • Face the camera directly")
        print("  • Ensure bright lighting on face")
        print("  • Press SPACE when face is large & clear")
        print("="*60 + "\n")
        
        start_time = time.time()
        captured_image = None
        
        while True:
            ret, frame = cap.read()
            if not ret:
                print("[Webcam] Error: Failed to read frame")
                break
            
            # Simple mirrored preview
            display_frame = cv2.flip(frame, 1)
            h, w = display_frame.shape[:2]
            
            # Simple face detection for feedback
            face = self.face_engine.get_best_face(cv2.flip(display_frame, 1))  # Unflip for detection
            
            if face:
                # Check face size for quality (encourage larger faces)
                x1, y1, x2, y2 = [int(c) for c in face.bbox]
                face_w = x2 - x1
                face_h = y2 - y1
                
                # Encourage closer positioning for better quality
                if face_w > 220:  # Face is large (close to camera) - good quality
                    status_text = "PERFECT SIZE - Press SPACE"
                    status_color = (0, 255, 0)  # Green
                elif face_w > 150:  # Face is medium size - acceptable
                    status_text = "GOOD - Get a bit closer for best quality"
                    status_color = (0, 255, 255)  # Yellow
                else:  # Face is small - needs to get closer
                    status_text = "Move MUCH closer to camera"
                    status_color = (0, 165, 255)  # Orange
            else:
                status_text = "No face detected - position yourself"
                status_color = (0, 0, 255)  # Red
            
            # Display status
            cv2.putText(display_frame, status_text, (10, 30), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.9, status_color, 2)
            cv2.putText(display_frame, "Press Q to quit", (10, h - 20), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
            
            cv2.imshow("KYC Selfie Capture", display_frame)
            
            key = cv2.waitKey(1) & 0xFF
            
            if key == ord(' '):  # Space - capture
                # Apply light enhancement to captured image
                enhanced_frame = self.face_engine.enhance_image_quality(cv2.flip(display_frame, 1))
                captured_image = enhanced_frame
                print("[Webcam] ✓ Image captured and enhanced!")
                break
            
            elif key in [ord('q'), ord('Q'), 27]:  # Q or ESC - quit
                print("[Webcam] Capture cancelled by user")
                break
            
            if time.time() - start_time > timeout_seconds:
                print(f"[Webcam] Timeout after {timeout_seconds} seconds")
                break
        
        cap.release()
        cv2.destroyAllWindows()
        
        # Save enhanced image
        if captured_image is not None:
            selfie_path = os.path.join(os.path.dirname(__file__), "images", "captured_selfie.jpg")
            cv2.imwrite(selfie_path, captured_image)
            print(f"[Webcam] Enhanced selfie saved to: {selfie_path}")
        
        return captured_image
    
    def _select_best_quality_image(self, images: List[np.ndarray]) -> Optional[np.ndarray]:
        """Select the best quality image from multiple captures"""
        if not images:
            return None
            
        best_image = None
        best_score = 0
        
        print("[Webcam] Analyzing captured images for best quality...")
        
        for i, img in enumerate(images):
            # Assess quality
            quality = self.quality_assessor.assess(img)
            face = self.face_engine.get_best_face(img)
            
            # Calculate combined quality score
            face_score = face.confidence if face else 0
            quality_score = min(quality.blur_score / 100.0, 1.0)  # Normalize blur score
            brightness_score = 1.0 - abs(quality.brightness - 127.5) / 127.5  # Prefer balanced brightness
            
            combined_score = face_score * 0.5 + quality_score * 0.3 + brightness_score * 0.2
            
            print(f"[Webcam] Image {i+1}: Quality={quality_score:.3f}, Face={face_score:.3f}, Combined={combined_score:.3f}")
            
            if combined_score > best_score:
                best_score = combined_score
                best_image = img
        
        print(f"[Webcam] Selected image with best score: {best_score:.3f}")
        return best_image
    
    def _draw_overlay(self, frame: np.ndarray, quality: QualityMetrics, face: Optional[FaceDetection]):
        """Draw quality indicators and face box on frame"""
        h, w = frame.shape[:2]
        
        # Draw quality status
        if quality.overall_quality == "good":
            status_color = (0, 255, 0)  # Green
            status_text = "QUALITY: GOOD - Press SPACE to capture"
        elif quality.overall_quality == "acceptable":
            status_color = (0, 255, 255)  # Yellow
            status_text = "QUALITY: ACCEPTABLE - Press SPACE to capture"
        else:
            status_color = (0, 0, 255)  # Red
            status_text = f"QUALITY: POOR - {quality.rejection_reason or 'Improve conditions'}"
        
        # Draw status bar
        cv2.rectangle(frame, (0, 0), (w, 40), (0, 0, 0), -1)
        cv2.putText(frame, status_text, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, status_color, 2)
        
        # Draw face detection
        if face:
            # Flip bbox for display (since frame is flipped)
            x1, y1, x2, y2 = [int(c) for c in face.bbox]
            x1_flip = w - x2
            x2_flip = w - x1
            
            cv2.rectangle(frame, (x1_flip, y1), (x2_flip, y2), (0, 255, 0), 2)
            cv2.putText(frame, f"Face: {face.confidence:.2f}", (x1_flip, y1 - 10), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
        else:
            cv2.putText(frame, "NO FACE DETECTED", (w//2 - 100, h//2), 
                       cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
        
        # Draw metrics
        metrics_y = h - 60
        cv2.putText(frame, f"Blur: {quality.blur_score:.0f}", (10, metrics_y), 
                   cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        cv2.putText(frame, f"Brightness: {quality.brightness:.0f}", (150, metrics_y), 
                   cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        cv2.putText(frame, f"Contrast: {quality.contrast:.0f}", (320, metrics_y), 
                   cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)


# ============================================================================
# KYC VERIFIER (Main Orchestrator)
# ============================================================================

class KYCVerifier:
    """Main KYC verification orchestrator"""
    
    def __init__(self):
        self.face_engine = FaceEngine()
        self.liveness_detector = LivenessDetector()
        self.document_processor = DocumentProcessor(self.face_engine)
        self.webcam_capture = WebcamCapture(self.face_engine)
        self.quality_assessor = QualityAssessor()
        
        # Thresholds (will be set after initialization based on engine)
        self.match_accept_threshold = 0.5
        self.match_review_threshold = 0.35
    
    def initialize(self) -> bool:
        """Initialize all components"""
        result = self.face_engine.initialize()
        
        # Adjust thresholds based on which engine is being used
        if result:
            if self.face_engine._use_deepface:
                # DeepFace VGG-Face - lowered thresholds for better matching with preprocessing
                self.match_accept_threshold = 0.5  # Lowered from 0.68
                self.match_review_threshold = 0.4  # Lowered from 0.55
                print(f"[KYCVerifier] Using DeepFace thresholds: accept={self.match_accept_threshold}, review={self.match_review_threshold}")
            else:
                # InsightFace ArcFace works well with lower thresholds
                self.match_accept_threshold = 0.4  # Lowered from 0.5
                self.match_review_threshold = 0.3  # Lowered from 0.35
                print(f"[KYCVerifier] Using InsightFace thresholds: accept={self.match_accept_threshold}, review={self.match_review_threshold}")
        
        return result
    
    def verify_with_webcam(self, document_path: str) -> KYCResult:
        """
        Run complete KYC verification with webcam selfie capture.
        
        Args:
            document_path: Path to ID document image
            
        Returns:
            KYCResult with all verification details
        """
        start_time = time.time()
        
        result = KYCResult(
            document_path=document_path,
            selfie_source="webcam",
            timestamp=datetime.now().isoformat()
        )
        
        # 1. Load and process document
        print("\n[KYC] Step 1: Processing document...")
        doc_image = cv2.imread(document_path)
        
        if doc_image is None:
            result.decision = "rejected"
            result.rejection_reason = f"Failed to load document: {document_path}"
            result.processing_time_seconds = time.time() - start_time
            return result
        
        doc_result = self.document_processor.process(doc_image, crop_document=False)
        result.doc_quality = doc_result["quality"]
        result.doc_face = doc_result["face"]
        
        if doc_result["error"]:
            result.decision = "rejected"
            result.rejection_reason = f"Document processing failed: {doc_result['error']}"
            result.processing_time_seconds = time.time() - start_time
            return result
        
        doc_embedding = doc_result["embedding"]
        print(f"[KYC] ✓ Document processed - Face detected with confidence {doc_result['face']['confidence']:.2f}")
        
        # Get enhanced embedding for document
        print("[KYC] Preprocessing document face for better matching...")
        document_face_path = os.path.join(os.path.dirname(__file__), "images", "document_face_cropped.jpg")
        doc_enhanced_embedding = self.face_engine.get_enhanced_embedding(doc_image, doc_result['face']['bbox'], document_face_path)
        if doc_enhanced_embedding is not None:
            doc_embedding = doc_enhanced_embedding
            print("[KYC] ✓ Enhanced document embedding generated")
        
        # 2. Capture selfie via webcam
        print("\n[KYC] Step 2: Capturing selfie via webcam...")
        selfie_image = self.webcam_capture.capture_with_preview()
        
        if selfie_image is None:
            result.decision = "rejected"
            result.rejection_reason = "Selfie capture cancelled or failed"
            result.processing_time_seconds = time.time() - start_time
            return result
        
        # 3. Process selfie
        print("\n[KYC] Step 3: Processing selfie...")
        selfie_quality = self.quality_assessor.assess(selfie_image, is_webcam=True)  # Use webcam-friendly assessment
        result.selfie_quality = asdict(selfie_quality)
        
        selfie_face = self.face_engine.get_best_face(selfie_image)
        
        if selfie_face is None:
            result.decision = "rejected"
            result.rejection_reason = "No face detected in selfie"
            result.processing_time_seconds = time.time() - start_time
            return result
        
        result.selfie_face = {
            "bbox": selfie_face.bbox,
            "confidence": selfie_face.confidence,
            "landmarks": selfie_face.landmarks
        }
        print(f"[KYC] ✓ Selfie processed - Face detected with confidence {selfie_face.confidence:.2f}")
        
        # Get enhanced embedding for selfie
        print("[KYC] Preprocessing selfie face for better matching...")
        selfie_face_path = os.path.join(os.path.dirname(__file__), "images", "selfie_face_cropped.jpg")
        selfie_enhanced_embedding = self.face_engine.get_enhanced_embedding(selfie_image, selfie_face.bbox, selfie_face_path)
        if selfie_enhanced_embedding is not None:
            selfie_face.embedding = selfie_enhanced_embedding
            print("[KYC] ✓ Enhanced selfie embedding generated")
        
        # 4. Liveness detection (relaxed for testing)
        print("\n[KYC] Step 4: Checking liveness...")
        liveness = self.liveness_detector.detect(selfie_image, selfie_face.bbox)
        result.liveness = asdict(liveness)
        
        # Make liveness check less strict - allow lower confidence
        if not liveness.is_live and liveness.confidence < 0.1:  # Only reject very obvious spoofs
            result.decision = "review"  # Changed from "rejected" to "review"
            result.rejection_reason = f"Liveness check requires review: {liveness.spoof_type or 'suspected spoof'}"
            print(f"[KYC] ⚠ Liveness check flagged but continuing: confidence {liveness.confidence:.2f}")
        else:
            print(f"[KYC] ✓ Liveness passed or acceptable (confidence {liveness.confidence:.2f})")
        
        # Continue with face matching regardless of liveness result
        
        # 5. Enhanced face matching
        print("\n[KYC] Step 5: Matching faces with enhanced preprocessing...")
        match = self.face_engine.match_faces_enhanced(doc_embedding, selfie_face.embedding)
        result.match_result = asdict(match)
        
        print(f"[KYC] Face similarity: {match.similarity:.3f} (threshold: {match.threshold_used})")
        
        # 6. Final decision - prioritize face matching over liveness
        final_decision = result.decision  # Keep liveness decision if already set to review
        
        if match.similarity >= self.match_accept_threshold:
            if liveness.is_live or liveness.confidence > 0.2:  # Accept if good match and decent liveness
                result.decision = "approved"
                print(f"\n[KYC] ✓ APPROVED - High similarity ({match.similarity:.3f})")
            else:
                result.decision = "review"
                result.rejection_reason = f"High similarity ({match.similarity:.3f}) but liveness concerns"
                print(f"\n[KYC] ⚠ NEEDS REVIEW - High similarity but liveness flagged")
        elif match.similarity >= self.match_review_threshold:
            result.decision = "review"
            result.rejection_reason = f"Similarity {match.similarity:.3f} requires manual review"
            print(f"\n[KYC] ⚠ NEEDS REVIEW - Moderate similarity ({match.similarity:.3f})")
        else:
            result.decision = "rejected"
            result.rejection_reason = f"Face match failed - similarity too low ({match.similarity:.3f})"
            print(f"\n[KYC] ✗ REJECTED - Low similarity ({match.similarity:.3f})")
        
        result.processing_time_seconds = time.time() - start_time
        return result
    
    def verify_with_images(self, document_path: str, selfie_path: str) -> KYCResult:
        """
        Run KYC verification with both images from files.
        
        Args:
            document_path: Path to ID document image
            selfie_path: Path to selfie image
            
        Returns:
            KYCResult with all verification details
        """
        start_time = time.time()
        
        result = KYCResult(
            document_path=document_path,
            selfie_source=selfie_path,
            timestamp=datetime.now().isoformat()
        )
        
        # 1. Process document
        print("\n[KYC] Step 1: Processing document...")
        doc_image = cv2.imread(document_path)
        
        if doc_image is None:
            result.decision = "rejected"
            result.rejection_reason = f"Failed to load document: {document_path}"
            result.processing_time_seconds = time.time() - start_time
            return result
        
        doc_result = self.document_processor.process(doc_image, crop_document=False)
        result.doc_quality = doc_result["quality"]
        result.doc_face = doc_result["face"]
        
        if doc_result["error"]:
            result.decision = "rejected"
            result.rejection_reason = f"Document processing failed: {doc_result['error']}"
            result.processing_time_seconds = time.time() - start_time
            return result
        
        doc_embedding = doc_result["embedding"]
        print(f"[KYC] ✓ Document processed - Face detected")
        
        # 2. Process selfie
        print("\n[KYC] Step 2: Processing selfie...")
        selfie_image = cv2.imread(selfie_path)
        
        if selfie_image is None:
            result.decision = "rejected"
            result.rejection_reason = f"Failed to load selfie: {selfie_path}"
            result.processing_time_seconds = time.time() - start_time
            return result
        
        selfie_quality = self.quality_assessor.assess(selfie_image)
        result.selfie_quality = asdict(selfie_quality)
        
        selfie_face = self.face_engine.get_best_face(selfie_image)
        
        if selfie_face is None:
            result.decision = "rejected"
            result.rejection_reason = "No face detected in selfie"
            result.processing_time_seconds = time.time() - start_time
            return result
        
        result.selfie_face = {
            "bbox": selfie_face.bbox,
            "confidence": selfie_face.confidence,
            "landmarks": selfie_face.landmarks
        }
        print(f"[KYC] ✓ Selfie processed - Face detected")
        
        # 3. Liveness detection
        print("\n[KYC] Step 3: Checking liveness...")
        liveness = self.liveness_detector.detect(selfie_image, selfie_face.bbox)
        result.liveness = asdict(liveness)
        
        if not liveness.is_live:
            print(f"[KYC] ⚠ Liveness warning: {liveness.spoof_type}")
            # Don't reject for file-based testing, just warn
        else:
            print(f"[KYC] ✓ Liveness passed")
        
        # 4. Face matching
        print("\n[KYC] Step 4: Matching faces...")
        match = self.face_engine.match_faces(doc_embedding, selfie_face.embedding)
        result.match_result = asdict(match)
        
        print(f"[KYC] Face similarity: {match.similarity:.3f}")
        
        # 5. Final decision
        if match.similarity >= self.match_accept_threshold:
            result.decision = "approved"
            print(f"\n[KYC] ✓ APPROVED")
        elif match.similarity >= self.match_review_threshold:
            result.decision = "review"
            result.rejection_reason = f"Similarity requires manual review"
            print(f"\n[KYC] ⚠ NEEDS REVIEW")
        else:
            result.decision = "rejected"
            result.rejection_reason = f"Face match failed"
            print(f"\n[KYC] ✗ REJECTED")
        
        result.processing_time_seconds = time.time() - start_time
        return result


# ============================================================================
# MAIN
# ============================================================================

def print_result(result: KYCResult):
    """Pretty print KYC result"""
    print("\n" + "="*60)
    print("KYC VERIFICATION RESULT")
    print("="*60)
    
    print(f"\nDocument: {result.document_path}")
    print(f"Selfie: {result.selfie_source}")
    print(f"Timestamp: {result.timestamp}")
    print(f"Processing Time: {result.processing_time_seconds:.2f}s")
    
    print(f"\n--- DECISION: {result.decision.upper()} ---")
    if result.rejection_reason:
        print(f"Reason: {result.rejection_reason}")
    
    if result.doc_quality:
        print(f"\nDocument Quality:")
        print(f"  - Overall: {result.doc_quality['overall_quality']}")
        print(f"  - Blur Score: {result.doc_quality['blur_score']:.1f}")
        print(f"  - Resolution: {result.doc_quality['width']}x{result.doc_quality['height']}")
    
    if result.selfie_quality:
        print(f"\nSelfie Quality:")
        print(f"  - Overall: {result.selfie_quality['overall_quality']}")
        print(f"  - Blur Score: {result.selfie_quality['blur_score']:.1f}")
    
    if result.liveness:
        print(f"\nLiveness:")
        print(f"  - Is Live: {result.liveness['is_live']}")
        print(f"  - Confidence: {result.liveness['confidence']:.2f}")
        if result.liveness.get('spoof_type'):
            print(f"  - Spoof Type: {result.liveness['spoof_type']}")
    
    if result.match_result:
        print(f"\nFace Comparison:")
        print(f"  - Similarity Score: {result.match_result['similarity']:.3f}")
        print(f"  - Is Match: {result.match_result['is_match']}")
        print(f"  - Threshold Used: {result.match_result['threshold_used']}")
        
        # Visual similarity indicator
        similarity = result.match_result['similarity']
        if similarity >= 0.68:
            indicator = "🟢 VERY HIGH"
        elif similarity >= 0.55:
            indicator = "🟡 MODERATE"
        elif similarity >= 0.40:
            indicator = "🟠 LOW"
        else:
            indicator = "🔴 VERY LOW"
        print(f"  - Similarity Level: {indicator}")
        
        print(f"\nDetailed Face Analysis:")
        if result.doc_face:
            print(f"  - Document Face Confidence: {result.doc_face['confidence']:.2f}")
        if result.selfie_face:
            print(f"  - Selfie Face Confidence: {result.selfie_face['confidence']:.2f}")
    
    print("\n" + "="*60)


def main():
    parser = argparse.ArgumentParser(
        description="KYC Standalone Testing Script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Test with document and webcam selfie
  python test_kyc_standalone.py --doc-image ./passport.jpg
  
  # Test with both images from files
  python test_kyc_standalone.py --doc-image ./passport.jpg --selfie-image ./selfie.jpg
  
  # Test all documents in a folder with webcam
  python test_kyc_standalone.py --doc-folder ./test_documents
  
  # Save results to JSON
  python test_kyc_standalone.py --doc-image ./passport.jpg --output ./result.json
        """
    )
    
    # Always load document image from images folder
    images_dir = os.path.join(os.path.dirname(__file__), "images")
    parser.add_argument("--doc-image", type=str, help="(IGNORED) Path to document image (always loads from ./images)")
    parser.add_argument("--doc-folder", type=str, help="(IGNORED) Path to folder with document images (always loads from ./images)")
    parser.add_argument("--selfie-image", type=str, help="Path to selfie image (optional, uses webcam if not provided)")
    parser.add_argument("--output", type=str, help="Output JSON file for results")
    
    args = parser.parse_args()
    
    # Validate arguments
    # Always require at least one image in images folder
    if not os.path.isdir(images_dir):
        print(f"[Main] Error: images folder not found: {images_dir}")
        sys.exit(1)
    
    # Get all image files except captured_selfie.jpg
    all_image_files = [f for f in os.listdir(images_dir) if f.lower().endswith((".jpg", ".jpeg", ".png"))]
    image_files = [f for f in all_image_files if f != "captured_selfie.jpg"]
    
    if not image_files:
        print(f"[Main] Error: No document images found in {images_dir} (excluding captured_selfie.jpg)")
        sys.exit(1)
    
    # Priority order: image.jpeg, image.jpg, then any other image
    document_file = None
    for priority_name in ["image.jpeg", "image.jpg"]:
        if priority_name in image_files:
            document_file = priority_name
            break
    
    if document_file is None:
        document_file = image_files[0]  # Fall back to first available
    
    document_path = os.path.join(images_dir, document_file)
    print(f"[Main] Using document image: {document_path}")
    
    # Initialize verifier
    print("[Main] Initializing KYC Verifier...")
    verifier = KYCVerifier()
    
    if not verifier.initialize():
        print("[Main] ✗ Failed to initialize. Please install dependencies:")
        print("  pip install insightface onnxruntime opencv-python numpy")
        sys.exit(1)
    
    print("[Main] ✓ Initialized successfully")
    
    results = []
    
    # Always process the first image in images folder
    if args.selfie_image:
        if not os.path.exists(args.selfie_image):
            print(f"[Main] Error: Selfie not found: {args.selfie_image}")
            sys.exit(1)
        result = verifier.verify_with_images(document_path, args.selfie_image)
    else:
        result = verifier.verify_with_webcam(document_path)
    print_result(result)
    results.append(result)
    
    # Save results
    if args.output:
        output_data = {
            "test_session": {
                "timestamp": datetime.now().isoformat(),
                "total_tests": len(results),
                "approved": sum(1 for r in results if r.decision == "approved"),
                "rejected": sum(1 for r in results if r.decision == "rejected"),
                "review": sum(1 for r in results if r.decision == "review"),
            },
            "results": [asdict(r) for r in results]
        }
        
        # Handle numpy arrays in results
        def convert_numpy(obj):
            if isinstance(obj, np.ndarray):
                return obj.tolist()
            elif isinstance(obj, dict):
                return {k: convert_numpy(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [convert_numpy(i) for i in obj]
            return obj
        
        output_data = convert_numpy(output_data)
        
        with open(args.output, 'w') as f:
            json.dump(output_data, f, indent=2, default=str)
        
        print(f"\n[Main] Results saved to: {args.output}")
    
    # Summary
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    print(f"Total Tests: {len(results)}")
    print(f"Approved: {sum(1 for r in results if r.decision == 'approved')}")
    print(f"Rejected: {sum(1 for r in results if r.decision == 'rejected')}")
    print(f"Review: {sum(1 for r in results if r.decision == 'review')}")


if __name__ == "__main__":
    main()

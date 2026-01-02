#!/usr/bin/env python3
"""
Quick KYC Component Tests

Test individual KYC components quickly:
- OCR only
- Authenticity only  
- Liveness only
- Face matching only

Usage:
python quick_kyc_test.py ocr path/to/id_card.jpg
python quick_kyc_test.py authenticity path/to/id_card.jpg
python quick_kyc_test.py liveness path/to/selfie.jpg
python quick_kyc_test.py face_match path/to/id_card.jpg path/to/selfie.jpg
"""

import os
import sys
import time
from PIL import Image

# Add src to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))


def load_image(path):
    """Load and prepare image"""
    try:
        image = Image.open(path)
        if image.mode != 'RGB':
            image = image.convert('RGB')
        print(f"✅ Loaded image: {image.size} pixels")
        return image
    except Exception as e:
        print(f"❌ Failed to load image: {e}")
        return None


def test_ocr(image_path):
    """Test OCR extraction"""
    from src.services.kyc.ocr_service import extract_text
    
    print("🔍 Testing OCR Extraction...")
    image = load_image(image_path)
    if not image:
        return
    
    start_time = time.time()
    result = extract_text(image)
    processing_time = time.time() - start_time
    
    print(f"⏱️  Time: {processing_time:.2f}s")
    print(f"📄 Results:")
    for key, value in result.items():
        print(f"   {key}: {value}")


def test_authenticity(image_path):
    """Test document authenticity"""
    from src.services.kyc.document_verification import check_authenticity
    
    print("🔍 Testing Document Authenticity...")
    image = load_image(image_path)
    if not image:
        return
    
    start_time = time.time()
    result = check_authenticity(image)
    processing_time = time.time() - start_time
    
    print(f"⏱️  Time: {processing_time:.2f}s")
    print(f"🛡️  Authentic: {result.get('is_authentic')}")
    print(f"📊 Score: {result.get('authenticity_score', 0.0):.4f}")
    print(f"🏷️  Flags: {result.get('flags', {})}")


def test_liveness(image_path):
    """Test liveness detection"""
    from src.services.kyc.liveness_service import detect_liveness
    
    print("🔍 Testing Liveness Detection...")
    image = load_image(image_path)
    if not image:
        return
    
    start_time = time.time()
    result = detect_liveness(image, is_video=False)
    processing_time = time.time() - start_time
    
    print(f"⏱️  Time: {processing_time:.2f}s")
    print(f"👤 Status: {result.get('liveness')}")
    print(f"📊 Confidence: {result.get('confidence', 0.0):.3f}")
    print(f"🏷️  Quality: {result.get('quality_score', 0.0):.3f}")


def test_face_match(id_path, selfie_path):
    """Test face matching"""
    from src.services.kyc.face_matching import match_faces
    
    print("🔍 Testing Face Matching...")
    id_image = load_image(id_path)
    selfie_image = load_image(selfie_path)
    
    if not id_image or not selfie_image:
        return
    
    start_time = time.time()
    result = match_faces(id_image, selfie_image)
    processing_time = time.time() - start_time
    
    print(f"⏱️  Time: {processing_time:.2f}s")
    print(f"👥 Score: {result.get('similarity_score', 0.0):.4f}")
    print(f"✅ Match: {result.get('is_match')}")
    print(f"📊 ID Quality: {result.get('id_photo_quality', 0.0):.3f}")
    print(f"📊 Selfie Quality: {result.get('selfie_quality', 0.0):.3f}")


def main():
    if len(sys.argv) < 3:
        print("Usage:")
        print("  python quick_kyc_test.py ocr <id_photo>")
        print("  python quick_kyc_test.py authenticity <id_photo>")
        print("  python quick_kyc_test.py liveness <selfie>")
        print("  python quick_kyc_test.py face_match <id_photo> <selfie>")
        return
    
    command = sys.argv[1]
    
    try:
        if command == "ocr":
            test_ocr(sys.argv[2])
        elif command == "authenticity":
            test_authenticity(sys.argv[2])
        elif command == "liveness":
            test_liveness(sys.argv[2])
        elif command == "face_match":
            if len(sys.argv) < 4:
                print("❌ Face matching requires both ID photo and selfie paths")
                return
            test_face_match(sys.argv[2], sys.argv[3])
        else:
            print(f"❌ Unknown command: {command}")
    except Exception as e:
        print(f"❌ Test failed: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()
"""
Simple KYC Face Matching Test
Just loads document from images folder, captures selfie, and shows result.
"""
import os
import sys
import cv2
import time
from PIL import Image

# Use main KYC engine from q_python
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'q_python'))
from src.services.kyc.face_matching import match_faces, get_engine_status


def capture_selfie():
    """Capture selfie from webcam - replaces old selfie if exists"""
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("ERROR: Cannot open webcam")
        return None
    
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    
    images_dir = os.path.join(os.path.dirname(__file__), "images")
    os.makedirs(images_dir, exist_ok=True)
    selfie_path = os.path.join(images_dir, "captured_selfie.jpg")
    
    # Check if old selfie exists
    if os.path.exists(selfie_path):
        print(f"Note: Will replace existing selfie")
    
    print("\nPress SPACE to capture selfie, Q to quit")
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        display = cv2.flip(frame, 1)
        cv2.putText(display, "SPACE=Capture  Q=Quit", (10, 30), 
                   cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
        cv2.imshow("Capture Selfie", display)
        
        key = cv2.waitKey(1) & 0xFF
        
        if key == ord(' '):
            cv2.imwrite(selfie_path, cv2.flip(display, 1))
            print(f"Selfie saved (replaced): {selfie_path}")
            break
        elif key in [ord('q'), ord('Q'), 27]:
            print("Cancelled")
            selfie_path = None
            break
    
    cap.release()
    cv2.destroyAllWindows()
    return selfie_path


def main():
    print("="*60)
    print("KYC FACE MATCHING TEST")
    print("="*60)
    
    # 1. Find document image
    images_dir = os.path.join(os.path.dirname(__file__), "images")
    doc_path = None
    for name in ["image.jpeg", "image.jpg", "document.jpg", "passport.jpg"]:
        path = os.path.join(images_dir, name)
        if os.path.exists(path):
            doc_path = path
            break
    
    if not doc_path:
        print("ERROR: No document image found in images folder")
        return
    
    print(f"Document: {os.path.basename(doc_path)}")
    
    # 2. Check engine
    print("\nChecking KYC engine...")
    status = get_engine_status()
    if not status.get('initialized'):
        print("ERROR: KYC engine not initialized")
        return
    print(f"Engine ready: {status['engine']}")
    
    # 3. Capture selfie
    print("\nOpening webcam...")
    selfie_path = capture_selfie()
    if not selfie_path:
        return
    
    # 4. Run face matching
    print("\nRunning face matching...")
    start = time.time()
    
    doc_img = Image.open(doc_path)
    selfie_img = Image.open(selfie_path)
    
    result = match_faces(doc_img, selfie_img)
    
    elapsed = time.time() - start
    
    # 5. Show result
    print("\n" + "="*60)
    print("RESULT")
    print("="*60)
    print(f"Decision: {result['decision'].upper()}")
    print(f"Similarity: {result['similarity']:.3f}")
    print(f"Threshold: {result['threshold']}")
    print(f"Processing time: {elapsed:.1f}s")
    
    if 'liveness' in result and result['liveness']:
        liveness = result['liveness']
        print(f"\nLiveness: {'PASS' if liveness['is_live'] else 'FAIL'}")
        print(f"Confidence: {liveness['confidence']:.2f}")
        if liveness.get('spoof_type'):
            print(f"Spoof detected: {liveness['spoof_type']}")
    
    if 'id_face_quality' in result:
        print(f"\nDocument quality: {result['id_face_quality']['overall_quality']}")
    if 'selfie_face_quality' in result:
        print(f"Selfie quality: {result['selfie_face_quality']['overall_quality']}")
    
    print("="*60)


if __name__ == "__main__":
    main()

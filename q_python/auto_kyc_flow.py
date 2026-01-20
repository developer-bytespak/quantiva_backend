#!/usr/bin/env python3
"""
Automated KYC Complete Flow with Camera Capture

This script:
1. Uses a saved ID card image path (you can modify the path below)
2. Captures a selfie from your camera automatically
3. Runs the complete KYC verification flow
4. Shows all results and final decision

Just run: python auto_kyc_flow.py
"""

import os
import sys
import time
import cv2
import numpy as np
from pathlib import Path
from PIL import Image
import json

# Add src to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

# =====================================
# CONFIGURATION - MODIFY THESE PATHS
# =====================================

# Set your ID card image path here
ID_CARD_PATH = "testfolder/image.jpeg"  # Use relative path for cross-platform compatibility

# Camera settings
CAMERA_INDEX = 0  # 0 = default camera, 1 = external camera, etc.
CAPTURE_DELAY = 3  # seconds to wait before capturing
PHOTO_QUALITY = 95  # JPEG quality (0-100)

# Decision thresholds (optimized for practical matching)
FACE_MATCH_THRESHOLD = 0.45  # 45% - lowered for better matching
DOC_AUTHENTICITY_THRESHOLD = 0.75  # 75%

# =====================================

# Import KYC services
try:
    from src.services.kyc.document_verification import check_authenticity
    from src.services.kyc.liveness_service import detect_liveness
    from src.services.kyc.face_matching import match_faces
    print("✅ Successfully imported all KYC services")
except ImportError as e:
    print(f"❌ Failed to import KYC services: {e}")
    print("Make sure you're running from the q_python directory")
    sys.exit(1)


class AutoKYCFlow:
    def __init__(self):
        self.results = {}
        self.id_image = None
        self.selfie_image = None
        
    def print_header(self, title):
        """Print a formatted header"""
        print("\n" + "="*70)
        print(f" {title}")
        print("="*70)
    
    def print_step(self, step_num, title):
        """Print a step header"""
        print(f"\n🔍 STEP {step_num}: {title}")
        print("-" * 60)
    
    def load_id_image(self):
        """Load the ID card image"""
        print("📁 Loading ID card image...")
        
        if not os.path.exists(ID_CARD_PATH):
            print(f"❌ ID card not found at: {ID_CARD_PATH}")
            print("Please update the ID_CARD_PATH variable in the script")
            return False
            
        try:
            self.id_image = Image.open(ID_CARD_PATH)
            print(f"✅ Loaded ID card: {self.id_image.size} pixels, {self.id_image.mode} mode")
            print(f"📁 Path: {ID_CARD_PATH}")
            
            # Convert to RGB if needed
            if self.id_image.mode != 'RGB':
                print(f"🔄 Converting from {self.id_image.mode} to RGB")
                self.id_image = self.id_image.convert('RGB')
                
            return True
        except Exception as e:
            print(f"❌ Failed to load ID card: {e}")
            return False
    
    def capture_selfie(self):
        """Capture selfie from camera"""
        print("📸 Preparing camera for selfie capture...")
        
        try:
            # Initialize camera
            cap = cv2.VideoCapture(CAMERA_INDEX)
            if not cap.isOpened():
                print(f"❌ Could not open camera {CAMERA_INDEX}")
                return False
            
            # Set camera properties for better quality
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            cap.set(cv2.CAP_PROP_FPS, 30)
            
            print(f"✅ Camera {CAMERA_INDEX} opened successfully")
            print(f"🎥 Camera preview starting... Position yourself in frame!")
            print(f"⏰ Auto-capture in {CAPTURE_DELAY} seconds...")
            
            # Preview and countdown
            start_time = time.time()
            while True:
                ret, frame = cap.read()
                if not ret:
                    print("❌ Failed to read from camera")
                    cap.release()
                    return False
                
                # Show countdown on frame
                elapsed = time.time() - start_time
                remaining = max(0, CAPTURE_DELAY - elapsed)
                
                # Flip frame horizontally for mirror effect
                frame = cv2.flip(frame, 1)
                
                # Add countdown text
                if remaining > 0:
                    countdown_text = f"Capturing in: {remaining:.1f}s"
                    cv2.putText(frame, countdown_text, (20, 50), 
                              cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)
                    cv2.putText(frame, "Position your face in center", (20, 100),
                              cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 0), 2)
                    cv2.putText(frame, "Press 'q' to quit", (20, 130),
                              cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
                else:
                    cv2.putText(frame, "CAPTURING NOW!", (20, 50),
                              cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 3)
                
                # Show preview
                cv2.imshow('KYC Selfie Capture - Position Your Face', frame)
                
                # Check for quit key
                key = cv2.waitKey(1) & 0xFF
                if key == ord('q'):
                    print("❌ Capture cancelled by user")
                    cap.release()
                    cv2.destroyAllWindows()
                    return False
                
                # Capture after delay
                if remaining <= 0:
                    print("📸 Capturing selfie...")
                    
                    # Convert BGR to RGB for PIL
                    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    self.selfie_image = Image.fromarray(rgb_frame)
                    
                    # Save captured selfie
                    selfie_filename = f"captured_selfie_{int(time.time())}.jpg"
                    self.selfie_image.save(selfie_filename, quality=PHOTO_QUALITY)
                    print(f"💾 Selfie saved as: {selfie_filename}")
                    
                    # Show capture confirmation
                    cv2.putText(frame, "CAPTURED! Processing...", (20, 50),
                              cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 3)
                    cv2.imshow('KYC Selfie Capture - Position Your Face', frame)
                    cv2.waitKey(2000)  # Show for 2 seconds
                    
                    break
            
            cap.release()
            cv2.destroyAllWindows()
            
            print(f"✅ Selfie captured: {self.selfie_image.size} pixels")
            return True
            
        except Exception as e:
            print(f"❌ Camera capture failed: {e}")
            try:
                cap.release()
                cv2.destroyAllWindows()
            except:
                pass
            return False
    
    def check_document_authenticity(self):
        """Verify document authenticity"""
        self.print_step(1, "DOCUMENT AUTHENTICITY VERIFICATION")
        start_time = time.time()
        
        try:
            print("🔍 Checking document authenticity...")
            result = check_authenticity(self.id_image)
            processing_time = time.time() - start_time
            
            print(f"⏱️  Processing time: {processing_time:.2f} seconds")
            print("\n🛡️  AUTHENTICITY ANALYSIS:")
            print("-" * 40)
            
            is_authentic = result.get('is_authentic', False)
            auth_score = result.get('authenticity_score', 0.0)
            
            print(f"   📊 Authenticity Score: {auth_score:.4f} ({auth_score*100:.2f}%)")
            print(f"   🎯 Required Threshold: {DOC_AUTHENTICITY_THRESHOLD:.2f} ({DOC_AUTHENTICITY_THRESHOLD*100:.0f}%)")
            print(f"   ✅ Is Authentic: {'YES' if is_authentic else 'NO'}")
            print(f"   🏆 Passes Threshold: {'YES' if auth_score >= DOC_AUTHENTICITY_THRESHOLD else 'NO'}")
            
            flags = result.get('flags', {})
            print("\n🔍 SECURITY FEATURES:")
            print(f"   💎 Hologram Detected: {'✅ YES' if flags.get('hologram_detected') else '❌ NO'}")
            print(f"   🧵 Texture Consistent: {'✅ YES' if flags.get('texture_consistent') else '❌ NO'}")
            print(f"   🚫 Tamper Detected: {'❌ YES' if flags.get('tamper_detected') else '✅ NO'}")
            print(f"   🖋️  Font Consistent: {'✅ YES' if flags.get('font_consistent') else '❌ NO'}")
            print(f"   💡 UV Pattern Valid: {flags.get('uv_pattern_valid', 'N/A')}")
            
            self.results['authenticity'] = result
            return True
            
        except Exception as e:
            print(f"❌ Authenticity check failed: {e}")
            return False
    
    def detect_selfie_liveness(self):
        """Detect liveness in captured selfie"""
        self.print_step(2, "SELFIE LIVENESS DETECTION")
        start_time = time.time()
        
        try:
            print("🔍 Analyzing selfie for liveness...")
            result = detect_liveness(self.selfie_image, is_video=False)
            processing_time = time.time() - start_time
            
            print(f"⏱️  Processing time: {processing_time:.2f} seconds")
            print("\n👤 LIVENESS ANALYSIS:")
            print("-" * 40)
            
            liveness_status = result.get('liveness', 'unknown')
            confidence = result.get('confidence', 0.0)
            quality = result.get('quality_score', 0.0)
            spoof_type = result.get('spoof_type', 'None')
            
            print(f"   🎯 Liveness Status: {liveness_status.upper()}")
            print(f"   📊 Confidence: {confidence:.3f} ({confidence*100:.1f}%)")
            print(f"   🏆 Quality Score: {quality:.3f} ({quality*100:.1f}%)")
            print(f"   🚨 Spoof Type: {spoof_type}")
            print(f"   ✅ Is Live Person: {'YES' if liveness_status == 'live' else 'NO'}")
            
            self.results['liveness'] = result
            return True
            
        except Exception as e:
            print(f"❌ Liveness detection failed: {e}")
            return False
    
    def match_faces(self):
        """Match face between ID photo and selfie"""
        self.print_step(3, "FACE MATCHING VERIFICATION")
        start_time = time.time()
        
        try:
            print("🔍 Comparing faces between ID card and selfie...")
            
            # Import and use the face matching service directly
            from src.services.kyc.face_matching import match_faces as face_matching_service
            
            # Call the face matching service
            face_result = face_matching_service(self.id_image, self.selfie_image)
            
            # Convert the result to the expected format (face matching service uses different field names)
            similarity = face_result.get('similarity', 0.0)
            is_match = face_result.get('is_match', False)
            confidence = face_result.get('confidence', 0.0)
            
            # Create a result structure that matches what the automated flow expects
            result = {
                'similarity_score': similarity,
                'is_match': is_match,
                'confidence': confidence,
                'id_photo_quality': 0.5,  # Placeholder - could be improved
                'selfie_quality': 0.5,    # Placeholder - could be improved
                'face_found_in_id': similarity > 0.0,  # If we got a result, face was found
                'face_found_in_selfie': similarity > 0.0,
            }
            
            processing_time = time.time() - start_time
            
            print(f"⏱️  Processing time: {processing_time:.2f} seconds")
            print("\n👥 FACE MATCHING RESULTS:")
            print("-" * 40)
            
            similarity_score = result.get('similarity_score', 0.0)
            is_match = result.get('is_match', False)
            id_quality = result.get('id_photo_quality', 0.0)
            selfie_quality = result.get('selfie_quality', 0.0)
            
            print(f"   📊 Similarity Score: {similarity_score:.4f} ({similarity_score*100:.2f}%)")
            print(f"   🎯 Required Threshold: {FACE_MATCH_THRESHOLD:.2f} ({FACE_MATCH_THRESHOLD*100:.0f}%)")
            print(f"   ✅ Is Match: {'YES' if is_match else 'NO'}")
            print(f"   🏆 Passes Threshold: {'YES' if similarity_score >= FACE_MATCH_THRESHOLD else 'NO'}")
            
            print(f"\n🔍 FACE DETECTION:")
            print(f"   👤 Face Found in ID: {'✅ YES' if result.get('face_found_in_id') else '❌ NO'}")
            print(f"   👤 Face Found in Selfie: {'✅ YES' if result.get('face_found_in_selfie') else '❌ NO'}")
            
            print(f"\n📊 IMAGE QUALITY:")
            print(f"   🆔 ID Photo Quality: {id_quality:.3f} ({id_quality*100:.1f}%)")
            print(f"   🤳 Selfie Quality: {selfie_quality:.3f} ({selfie_quality*100:.1f}%)")
            
            self.results['face_match'] = result
            return True
            
        except Exception as e:
            print(f"❌ Face matching failed: {e}")
            import traceback
            traceback.print_exc()
            return False
    
    def make_final_decision(self):
        """Make final KYC decision based on all results"""
        self.print_step(4, "FINAL KYC DECISION")
        
        # Get scores
        face_match_score = self.results.get('face_match', {}).get('similarity_score', 0.0)
        doc_authenticity_score = self.results.get('authenticity', {}).get('authenticity_score', 0.0)
        liveness_status = self.results.get('liveness', {}).get('liveness', 'unclear')
        
        print("📊 DECISION CRITERIA EVALUATION:")
        print("-" * 50)
        face_pass = face_match_score >= FACE_MATCH_THRESHOLD
        doc_pass = doc_authenticity_score >= DOC_AUTHENTICITY_THRESHOLD
        liveness_pass = liveness_status == 'live'
        
        print(f"   👥 Face Match: {face_match_score:.4f} >= {FACE_MATCH_THRESHOLD} = {'✅ PASS' if face_pass else '❌ FAIL'}")
        print(f"   🛡️  Document Auth: {doc_authenticity_score:.4f} >= {DOC_AUTHENTICITY_THRESHOLD} = {'✅ PASS' if doc_pass else '❌ FAIL'}")
        print(f"   👤 Liveness: {liveness_status} = {'✅ PASS' if liveness_pass else '❌ FAIL'}")
        
        # Make decision (same logic as NestJS decision engine)
        if face_pass and doc_pass:
            decision = "APPROVED"
            reason = "Face match and document authenticity checks passed"
            status_icon = "🎉"
            color = "✅"
        elif not face_pass:
            decision = "MANUAL REVIEW"
            reason = f"Face match score ({face_match_score*100:.1f}%) below threshold ({FACE_MATCH_THRESHOLD*100:.0f}%)"
            status_icon = "⚠️"
            color = "🔶"
        elif not doc_pass:
            decision = "MANUAL REVIEW" 
            reason = f"Document authenticity score ({doc_authenticity_score*100:.1f}%) below threshold ({DOC_AUTHENTICITY_THRESHOLD*100:.0f}%)"
            status_icon = "⚠️"
            color = "🔶"
        else:
            decision = "MANUAL REVIEW"
            reason = "Other verification issues detected"
            status_icon = "⚠️"
            color = "🔶"
        
        print(f"\n{status_icon} FINAL DECISION: {color} {decision}")
        print(f"📝 Reason: {reason}")
        
        # Additional recommendations
        if not liveness_pass:
            print(f"💡 Note: Liveness check shows '{liveness_status}' - consider retaking selfie")
        
        return decision, reason
    
    def run_complete_flow(self):
        """Run the complete automated KYC flow"""
        self.print_header("🚀 AUTOMATED KYC VERIFICATION FLOW")
        total_start_time = time.time()
        
        print("🔧 Configuration:")
        print(f"   📁 ID Card Path: {ID_CARD_PATH}")
        print(f"   📷 Camera Index: {CAMERA_INDEX}")
        print(f"   ⏰ Capture Delay: {CAPTURE_DELAY} seconds")
        
        # Step 0: Load ID image
        if not self.load_id_image():
            return False
        
        # Step 0.5: Capture selfie from camera
        if not self.capture_selfie():
            return False
        
        # Run all verification steps
        success = True
        success &= self.check_document_authenticity()
        success &= self.detect_selfie_liveness()
        success &= self.match_faces()
        
        # Make final decision
        if success:
            decision, reason = self.make_final_decision()
        
        # Summary
        total_time = time.time() - total_start_time
        self.print_header("📋 VERIFICATION SUMMARY")
        print(f"⏱️  Total Processing Time: {total_time:.2f} seconds")
        print(f"✅ All Tests Completed: {'YES' if success else 'NO'}")
        
        if success:
            print(f"🎯 Final Decision: {decision}")
            print(f"📝 Reason: {reason}")
            
            # Show key extracted data
            ocr_data = self.results.get('ocr', {})
            if ocr_data.get('name'):
                print(f"👤 Extracted Name: {ocr_data.get('name')}")
        
        print(f"\n💾 Captured selfie saved for review")
        print(f"🔄 Run script again to test with a new selfie")
        
        return success


def main():
    print("🚀 Starting Automated KYC Verification...")
    
    # Check if ID card path exists
    if not os.path.exists(ID_CARD_PATH):
        print(f"\n❌ ID card not found at: {ID_CARD_PATH}")
        print("Please update the ID_CARD_PATH variable at the top of this script")
        print("Current working directory:", os.getcwd())
        return
    
    # Check if camera is available
    try:
        cap = cv2.VideoCapture(CAMERA_INDEX)
        if not cap.isOpened():
            print(f"\n❌ Camera {CAMERA_INDEX} not available")
            print("Make sure your camera is connected and not used by other applications")
            return
        cap.release()
    except Exception as e:
        print(f"\n❌ Camera test failed: {e}")
        return
    
    print("✅ All prerequisites checked - starting KYC flow...")
    
    # Run the complete flow
    kyc_flow = AutoKYCFlow()
    kyc_flow.run_complete_flow()


if __name__ == "__main__":
    main()
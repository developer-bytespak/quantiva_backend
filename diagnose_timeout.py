#!/usr/bin/env python3
"""
Diagnostic script to test DeepFace initialization and face matching speed.
Run this to identify where the timeout is occurring.
"""
import time
import sys
import logging
from pathlib import Path

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s'
)
logger = logging.getLogger(__name__)

def test_deepface_import():
    """Test if DeepFace can be imported and initialized"""
    logger.info("=" * 70)
    logger.info("TEST 1: DeepFace Import and Initialization")
    logger.info("=" * 70)
    
    start = time.time()
    try:
        logger.info("Importing DeepFace...")
        from deepface import DeepFace
        import_time = time.time() - start
        logger.info(f"✓ DeepFace imported in {import_time:.2f}s")
        return True
    except Exception as e:
        elapsed = time.time() - start
        logger.error(f"✗ DeepFace import FAILED after {elapsed:.2f}s: {e}")
        return False

def test_face_embedding():
    """Test if face embedding extraction works"""
    logger.info("\n" + "=" * 70)
    logger.info("TEST 2: Face Embedding Extraction")
    logger.info("=" * 70)
    
    start = time.time()
    try:
        from PIL import Image
        import numpy as np
        from deepface import DeepFace
        
        # Create a test image
        logger.info("Creating test image...")
        dummy_image = Image.new('RGB', (224, 224), color=(100, 100, 100))
        img_array = np.array(dummy_image)
        
        logger.info(f"Starting embedding extraction (image shape: {img_array.shape})...")
        extract_start = time.time()
        
        # Try to extract embedding
        embedding = DeepFace.represent(img_array, model_name="VGG-Face", enforce_detection=False)
        
        extract_time = time.time() - extract_start
        logger.info(f"✓ Embedding extraction completed in {extract_time:.2f}s")
        logger.info(f"  Embedding shape: {np.array(embedding[0]['embedding']).shape}")
        
        total = time.time() - start
        logger.info(f"Total time for TEST 2: {total:.2f}s")
        return True
        
    except Exception as e:
        elapsed = time.time() - start
        logger.error(f"✗ Embedding extraction FAILED after {elapsed:.2f}s: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_python_api_server():
    """Test if Python API server is running"""
    logger.info("\n" + "=" * 70)
    logger.info("TEST 3: Python API Server Connectivity")
    logger.info("=" * 70)
    
    import requests
    
    try:
        logger.info("Checking Python API server at http://localhost:8000...")
        response = requests.get("http://localhost:8000/docs", timeout=5)
        if response.status_code == 200:
            logger.info("✓ Python API server is running and responding")
            return True
        else:
            logger.error(f"✗ Server returned status {response.status_code}")
            return False
    except requests.exceptions.ConnectionError:
        logger.error("✗ Cannot connect to Python API server at http://localhost:8000")
        logger.error("  Make sure the server is running with: python q_python/run.py")
        return False
    except Exception as e:
        logger.error(f"✗ Connection test failed: {e}")
        return False

def main():
    logger.info("\n")
    logger.info("╔" + "=" * 68 + "╗")
    logger.info("║" + " " * 68 + "║")
    logger.info("║" + "  KYC FACE MATCHING - TIMEOUT DIAGNOSTIC SUITE".center(68) + "║")
    logger.info("║" + " " * 68 + "║")
    logger.info("╚" + "=" * 68 + "╝")
    logger.info("\n")
    
    results = {}
    
    # Test 1: DeepFace import
    results['deepface_import'] = test_deepface_import()
    
    # Test 2: Face embedding (only if import succeeded)
    if results['deepface_import']:
        results['face_embedding'] = test_face_embedding()
    else:
        logger.warning("Skipping TEST 2 because DeepFace import failed")
        results['face_embedding'] = False
    
    # Test 3: API server
    results['api_server'] = test_python_api_server()
    
    # Summary
    logger.info("\n" + "=" * 70)
    logger.info("DIAGNOSTIC SUMMARY")
    logger.info("=" * 70)
    
    for test_name, passed in results.items():
        status = "✓ PASS" if passed else "✗ FAIL"
        logger.info(f"{test_name:.<50} {status}")
    
    all_passed = all(results.values())
    
    if all_passed:
        logger.info("\n" + "=" * 70)
        logger.info("✓ All diagnostics passed! Face matching should work properly.")
        logger.info("=" * 70)
        return 0
    else:
        logger.info("\n" + "=" * 70)
        logger.info("✗ Some diagnostics failed. See details above.")
        logger.info("=" * 70)
        return 1

if __name__ == '__main__':
    sys.exit(main())

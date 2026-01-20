# KYC Standalone Testing Environment

This folder contains a standalone KYC verification testing script that works independently 
from the main application. Use this to test and validate the InsightFace-based face matching
before integrating into the production system.

## Quick Start

### 1. Install Dependencies

```bash
cd kyc_standalone_test
pip install -r requirements.txt
```

### 2. Add Test Documents

Place your ID document images (passport, ID card, driver's license) in the `test_documents/` folder:
- Supported formats: JPG, JPEG, PNG, BMP
- Recommended resolution: At least 600x400 pixels
- Ensure the face on the document is clearly visible

### 3. Run Tests

**Test with webcam selfie capture:**
```bash
python test_kyc_standalone.py --doc-image ./test_documents/passport.jpg
```

**Test with both images from files:**
```bash
python test_kyc_standalone.py --doc-image ./test_documents/passport.jpg --selfie-image ./selfie.jpg
```

**Test all documents in folder:**
```bash
python test_kyc_standalone.py --doc-folder ./test_documents
```

**Save results to JSON:**
```bash
python test_kyc_standalone.py --doc-image ./test_documents/passport.jpg --output ./results.json
```

## Webcam Capture Instructions

When using webcam capture mode:
1. A window will open showing your webcam feed
2. Position your face in the center of the frame
3. Wait for "QUALITY: GOOD" status (green)
4. Press **SPACE** to capture
5. Press **Q** or **ESC** to cancel

## Understanding Results

### Decision Types
- **APPROVED**: Face match successful, identity verified
- **REJECTED**: Face match failed or quality too low
- **REVIEW**: Borderline case requiring manual review

### Quality Metrics
- **Blur Score**: Higher is better (>50 is good)
- **Brightness**: 40-220 is acceptable range
- **Contrast**: Higher means better visibility

### Similarity Thresholds
- **≥ 0.50**: Approved (high confidence match)
- **0.35 - 0.50**: Review (moderate confidence)
- **< 0.35**: Rejected (low confidence)

## Troubleshooting

### "InsightFace not installed"
```bash
pip install insightface onnxruntime
```

### "No face detected"
- Ensure document photo is clear and well-lit
- Face should be at least 100x100 pixels
- Avoid heavy shadows or glare

### Webcam not working
- Check webcam permissions
- Try: `cv2.VideoCapture(1)` if default camera fails
- Ensure no other app is using the webcam

## File Structure

```
kyc_standalone_test/
├── test_kyc_standalone.py    # Main testing script
├── requirements.txt          # Python dependencies
├── README.md                 # This file
├── test_documents/           # Place test ID documents here
│   ├── passport.jpg
│   ├── id_card.jpg
│   └── ...
└── results/                  # Output folder for results (created automatically)
```

## Next Steps

Once testing is complete and accuracy is validated:
1. The core engine will be integrated into `q_python/src/services/kyc/`
2. The standalone script can be deleted
3. Main application will use the same verified algorithms

# KYC Face Matching Test

Simple test script that uses the main KYC face matching engine.

## How to Run

```bash
cd kyc_standalone_test
..\q_python\venv\Scripts\python.exe test_kyc.py
```

## What It Does

1. Auto-loads document image from `images/` folder
2. Opens webcam to capture your selfie
3. Sends both images to the main KYC face matching engine
4. Shows the result

## Requirements

- Document image in `images/` folder (named `image.jpeg`, `image.jpg`, `document.jpg`, or `passport.jpg`)
- Webcam connected

## Result Includes

- **Decision**: APPROVED / REVIEW / REJECTED
- **Similarity Score**: 0.0 - 1.0
- **Liveness Detection**: PASS / FAIL
- **Quality Assessment**: good / fair / poor

The test uses the exact same face matching engine as the production API.

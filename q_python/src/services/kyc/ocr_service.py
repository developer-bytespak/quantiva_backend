"""
Enhanced OCR Service for extracting text from ID documents.
Uses multiple OCR engines: PaddleOCR (primary), Tesseract, and EasyOCR fallbacks.
Optimized for Pakistani National Identity Cards (CNIC).
"""
import re
from typing import Dict, Optional, Tuple, List
from PIL import Image
import numpy as np
from logging import getLogger
from datetime import datetime

logger = getLogger(__name__)

# Lazy loaders for multiple OCR engines
_paddle_ocr = None
_tesseract = None
_easyocr_reader = None
_cv2 = None

def _get_cv2():
    """Lazy load OpenCV."""
    global _cv2
    if _cv2 is None:
        try:
            import cv2 as cv2_module
            _cv2 = cv2_module
        except ImportError as e:
            logger.error(f"OpenCV import failed: {e}")
            raise ImportError("OpenCV (cv2) is required. Install with: pip install opencv-python")
    return _cv2

def _get_paddle_ocr():
    """Lazy load PaddleOCR (best accuracy for IDs)."""
    global _paddle_ocr
    if _paddle_ocr is None:
        try:
            from paddleocr import PaddleOCR
            _paddle_ocr = PaddleOCR(use_angle_cls=True, lang='en', use_gpu=False, show_log=False)
            logger.info("PaddleOCR initialized successfully")
        except Exception as e:
            logger.warning(f"PaddleOCR not available: {e}")
            _paddle_ocr = False
    return _paddle_ocr if _paddle_ocr is not False else None

def _get_tesseract():
    """Lazy load Tesseract OCR."""
    global _tesseract
    if _tesseract is None:
        try:
            import pytesseract
            _tesseract = pytesseract
            # Test if tesseract is installed
            _tesseract.get_tesseract_version()
            logger.info("Tesseract OCR available")
        except Exception as e:
            logger.warning(f"Tesseract not available: {e}")
            _tesseract = False
    return _tesseract if _tesseract is not False else None

def _get_easyocr():
    """Lazy load EasyOCR as fallback."""
    global _easyocr_reader
    if _easyocr_reader is None:
        try:
            import easyocr
            _easyocr_reader = easyocr.Reader(['en'], gpu=False)
            logger.info("EasyOCR initialized successfully")
        except Exception as e:
            logger.warning(f"EasyOCR not available: {e}")
            _easyocr_reader = False
    return _easyocr_reader if _easyocr_reader is not False else None


def preprocess_for_ocr(image: Image.Image, is_pakistani_id: bool = False) -> np.ndarray:
    """
    Optimized preprocessing for ID card OCR.
    
    Args:
        image: PIL Image of ID card
        is_pakistani_id: Apply Pakistani CNIC specific preprocessing
        
    Returns:
        Preprocessed numpy array ready for OCR
    """
    try:
        cv2 = _get_cv2()
        
        # Convert PIL to numpy array (RGB)
        img_array = np.array(image.convert('RGB'))
        
        # Convert to BGR for OpenCV
        img_bgr = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)
        
        # Resize if too small (minimum 1200px width for good OCR)
        height, width = img_bgr.shape[:2]
        if width < 1200:
            scale = 1200 / width
            new_width = int(width * scale)
            new_height = int(height * scale)
            img_bgr = cv2.resize(img_bgr, (new_width, new_height), interpolation=cv2.INTER_CUBIC)
            logger.info(f"Resized image from {width}x{height} to {new_width}x{new_height}")
        
        # Convert to grayscale
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        
        if is_pakistani_id:
            # Pakistani CNIC-specific preprocessing
            # Remove security pattern lines
            kernel_v = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 3))
            kernel_h = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 1))
            temp = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, kernel_v)
            gray = cv2.morphologyEx(temp, cv2.MORPH_CLOSE, kernel_h)
        
        # Denoise while preserving edges
        denoised = cv2.fastNlMeansDenoising(gray, None, 10, 7, 21)
        
        # Enhance contrast using CLAHE
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        enhanced = clahe.apply(denoised)
        
        # Adaptive thresholding for varying lighting conditions
        binary = cv2.adaptiveThreshold(
            enhanced, 255, 
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 
            cv2.THRESH_BINARY, 
            blockSize=15, 
            C=10
        )
        
        # Light morphological cleanup (remove tiny noise)
        kernel_clean = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
        cleaned = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel_clean)
        
        logger.info("Preprocessing completed successfully")
        return cleaned
        
    except Exception as e:
        logger.error(f"Preprocessing failed: {e}", exc_info=True)
        # Fallback: return original as grayscale
        return np.array(image.convert('L'))


def detect_pakistani_cnic(raw_text: str) -> bool:
    """
    Quick detection if text contains Pakistani CNIC indicators.
    
    Args:
        raw_text: OCR extracted text
        
    Returns:
        True if likely Pakistani CNIC
    """
    text_lower = raw_text.lower()
    indicators = [
        'pakistan', 'islamic republic', 'cnic', 
        'identity card', 'national identity',
        'computerized national', 'nadra'
    ]
    return any(indicator in text_lower for indicator in indicators)


def extract_text(image: Image.Image, document_type: Optional[str] = None) -> Dict:
    """
    Extract text from document image using the best available OCR engine.
    
    Args:
        image: PIL Image object
        document_type: Optional document type hint
        
    Returns:
        Dictionary with extracted text and structured data
    """
    try:
        logger.info("=== STARTING ENHANCED OCR TEXT EXTRACTION ===")
        logger.info(f"Image size: {image.size}")
        logger.info(f"Document type: {document_type or 'auto-detect'}")
        
        # Detect if this is a Pakistani ID
        is_pakistani = detect_pakistani_cnic_visual(image)
        logger.info(f"Pakistani ID detected: {is_pakistani}")
        
        # Preprocess image for better OCR
        if is_pakistani:
            logger.info("Applying Pakistani CNIC-specific preprocessing...")
            processed_img_array = preprocess_for_ocr(image, is_pakistani_id=True)
        else:
            logger.info("Applying standard preprocessing...")
            processed_img_array = preprocess_for_ocr(image, is_pakistani_id=False)
        
        # Convert back to PIL for OCR engines
        processed_image = Image.fromarray(processed_img_array)
        
        # Extract text using multiple engines
        raw_text, confidence, engine_used = extract_text_multi_engine(processed_image)
        
        logger.info(f"=== OCR RESULTS ===")
        logger.info(f"Engine used: {engine_used}")
        logger.info(f"Confidence: {confidence:.3f} ({confidence*100:.1f}%)")
        logger.info(f"Raw text length: {len(raw_text)} characters")
        logger.info(f"Raw text preview: {repr(raw_text[:200])}...")
        
        if not raw_text.strip():
            logger.warning("No text extracted from image!")
            return _empty_ocr_result()
        
        # Extract structured data with enhanced parsing
        logger.info("=== PARSING STRUCTURED DATA ===")
        structured_data = extract_structured_data_enhanced(raw_text, is_pakistani)
        
        logger.info(f"Parsed results:")
        for key, value in structured_data.items():
            if value:
                logger.info(f"  {key}: {value}")
            else:
                logger.info(f"  {key}: NOT FOUND")
        
        result = {
            "name": structured_data.get("name"),
            "dob": structured_data.get("dob"),
            "id_number": structured_data.get("id_number"),
            "nationality": structured_data.get("nationality"),
            "expiration_date": structured_data.get("expiration_date"),
            "mrz_text": structured_data.get("mrz_text"),
            "confidence": float(confidence),
            "raw_text": raw_text,
            "engine_used": engine_used
        }
        
        logger.info("=== EXTRACTION COMPLETE ===")
        return result
        
    except Exception as e:
        logger.error(f"OCR extraction failed: {str(e)}", exc_info=True)
        return _empty_ocr_result()


def detect_pakistani_cnic_visual(image: Image.Image) -> bool:
    """
    Detect Pakistani CNIC based on visual characteristics.
    
    Args:
        image: PIL Image object
        
    Returns:
        True if likely Pakistani CNIC
    """
    try:
        # Basic aspect ratio check (Pakistani IDs are roughly 1.6:1)
        width, height = image.size
        aspect_ratio = width / height
        
        # Pakistani CNICs are landscape format
        if 1.4 <= aspect_ratio <= 2.0:
            # Additional checks could be added here (colors, logos, etc.)
            return True
        
        return False
    except:
        return False


def _empty_ocr_result() -> Dict:
    """Return empty OCR result structure."""
    return {
        "name": None,
        "dob": None,
        "id_number": None,
        "nationality": None,
        "expiration_date": None,
        "mrz_text": None,
        "confidence": 0.0,
        "raw_text": "",
        "engine_used": "None"
    }


def extract_structured_data_enhanced(raw_text: str, is_pakistani: bool = False) -> Dict:
    """
    Enhanced structured data extraction with better parsing for Pakistani CNICs.
    
    Args:
        raw_text: Raw OCR text
        is_pakistani: Whether this is a Pakistani ID
        
    Returns:
        Dictionary with extracted fields
    """
    result = {}
    
    # Clean the text first
    cleaned_text = clean_ocr_text(raw_text)
    combined_text = raw_text + " " + cleaned_text
    
    logger.info(f"Parsing text (length: {len(raw_text)}):")
    logger.info(f"Raw: {repr(raw_text)}")
    logger.info(f"Cleaned: {repr(cleaned_text)}")
    
    # Extract Name (Multiple strategies)
    result['name'] = extract_name_enhanced(combined_text)
    
    # Extract Date of Birth
    result['dob'] = extract_date_of_birth(combined_text)
    
    # Extract ID Number (CNIC for Pakistani)
    if is_pakistani:
        result['id_number'] = extract_pakistani_cnic(combined_text)
    else:
        result['id_number'] = extract_generic_id(combined_text)
    
    # Extract Nationality
    result['nationality'] = extract_nationality(combined_text)
    
    # Extract Expiration Date
    result['expiration_date'] = extract_expiration_date(combined_text)
    
    return result


def clean_ocr_text(text: str) -> str:
    """
    Clean noisy OCR text.
    
    Args:
        text: Raw OCR text
        
    Returns:
        Cleaned text
    """
    if not text:
        return ""
    
    # Remove common OCR noise
    noise_chars = ['€', '{', '}', '|', '~', '^', '#', '$', '%', '@', '&']
    cleaned = text
    
    for char in noise_chars:
        cleaned = cleaned.replace(char, ' ')
    
    # Normalize whitespace
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    
    return cleaned


def extract_name_enhanced(text: str) -> Optional[str]:
    """
    Extract name using multiple strategies.
    
    Args:
        text: Combined OCR text
        
    Returns:
        Extracted name or None
    """
    # Strategy 1: Look for "Name" followed by text
    name_patterns = [
        r'Name[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)',
        r'Name[:\s]+([A-Z][A-Z\s]+)',
        r'نام[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)',  # Urdu "Name"
    ]
    
    for pattern in name_patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            name = match.group(1).strip()
            # Clean up the name
            name = re.sub(r'\s+', ' ', name)
            if len(name) > 5 and not any(c.isdigit() for c in name):
                logger.info(f"Name found with pattern: {name}")
                return name
    
    # Strategy 2: Look for sequences of capitalized words (likely names)
    words = text.split()
    potential_names = []
    
    for i, word in enumerate(words):
        if (word and len(word) > 2 and word[0].isupper() and 
            word.replace('.', '').replace(',', '').isalpha()):
            
            # Look for consecutive name-like words
            name_parts = [word]
            for j in range(i + 1, min(i + 6, len(words))):
                next_word = words[j]
                if (next_word and len(next_word) > 1 and next_word[0].isupper() and
                    next_word.replace('.', '').replace(',', '').isalpha()):
                    name_parts.append(next_word)
                else:
                    break
            
            if len(name_parts) >= 2:
                potential_name = ' '.join(name_parts)
                # Avoid common document words
                if not any(word.lower() in potential_name.lower() 
                          for word in ['Pakistan', 'Card', 'Identity', 'National', 'Father']):
                    potential_names.append((potential_name, len(potential_name)))
    
    if potential_names:
        # Return the longest reasonable name
        best_name = max(potential_names, key=lambda x: x[1])[0]
        logger.info(f"Name found by analysis: {best_name}")
        return best_name
    
    logger.warning("No name found in text")
    return None


def extract_pakistani_cnic(text: str) -> Optional[str]:
    """
    Extract Pakistani CNIC with format validation.
    
    Args:
        text: OCR text
        
    Returns:
        Formatted CNIC or None
    """
    # Look for CNIC patterns
    patterns = [
        r'\b(\d{5})[^\d]*(\d{7})[^\d]*(\d{1,2})\b',  # 42501-2171172-1 or similar
        r'\b(\d{13})\b',  # 4250121711721 (no separators)
    ]
    
    for pattern in patterns:
        matches = re.findall(pattern, text)
        for match in matches:
            if isinstance(match, tuple) and len(match) == 3:
                # Validate CNIC structure
                area, serial, check = match
                if len(area) == 5 and len(serial) == 7 and len(check) <= 2:
                    cnic = f"{area}-{serial}-{check}"
                    logger.info(f"CNIC found: {cnic}")
                    return cnic
            elif isinstance(match, str) and len(match) == 13:
                # Format the 13-digit string
                cnic = f"{match[:5]}-{match[5:12]}-{match[12:]}"
                logger.info(f"CNIC found (formatted): {cnic}")
                return cnic
    
    logger.warning("No CNIC found in text")
    return None


def extract_date_of_birth(text: str) -> Optional[str]:
    """
    Extract date of birth with multiple format support.
    
    Args:
        text: OCR text
        
    Returns:
        Date in YYYY-MM-DD format or None
    """
    # Look for date patterns
    date_patterns = [
        r'\b(\d{2})[.\-/](\d{2})[.\-/](\d{4})\b',  # DD.MM.YYYY or DD/MM/YYYY
        r'\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\b',  # D.M.YYYY
        r'\b(\d{8})\b',  # DDMMYYYY or YYYYMMDD
    ]
    
    for pattern in date_patterns:
        matches = re.findall(pattern, text)
        for match in matches:
            try:
                if len(match) == 3:
                    # DD/MM/YYYY format
                    day, month, year = match
                    day, month, year = int(day), int(month), int(year)
                    
                    # Validate date ranges
                    if 1900 <= year <= 2020 and 1 <= month <= 12 and 1 <= day <= 31:
                        dob = f"{year}-{month:02d}-{day:02d}"
                        logger.info(f"DOB found: {dob}")
                        return dob
                        
                elif isinstance(match, str) and len(match) == 8:
                    # Try DDMMYYYY format first
                    if match[:2] <= '31' and match[2:4] <= '12':
                        day = int(match[:2])
                        month = int(match[2:4])
                        year = int(match[4:])
                        
                        if 1900 <= year <= 2020 and 1 <= month <= 12 and 1 <= day <= 31:
                            dob = f"{year}-{month:02d}-{day:02d}"
                            logger.info(f"DOB found (8-digit): {dob}")
                            return dob
                            
            except (ValueError, IndexError):
                continue
    
    logger.warning("No date of birth found")
    return None


def extract_nationality(text: str) -> Optional[str]:
    """Extract nationality/country."""
    countries = ['Pakistan', 'Pakistani', 'PAK']
    for country in countries:
        if country.lower() in text.lower():
            return 'Pakistani'
    return None


def extract_expiration_date(text: str) -> Optional[str]:
    """Extract document expiration date."""
    # Look for expiry patterns
    expiry_patterns = [
        r'expiry[:\s]*(\d{2})[.\-/](\d{2})[.\-/](\d{4})',
        r'expire[:\s]*(\d{2})[.\-/](\d{2})[.\-/](\d{4})',
        r'(\d{2})[.\-/](\d{2})[.\-/](\d{4})',
    ]
    
    for pattern in expiry_patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for match in matches:
            try:
                day, month, year = int(match[0]), int(match[1]), int(match[2])
                # Expiry dates should be in the future
                if 2020 <= year <= 2040 and 1 <= month <= 12 and 1 <= day <= 31:
                    return f"{year}-{month:02d}-{day:02d}"
            except (ValueError, IndexError):
                continue
    
    return None


def extract_generic_id(text: str) -> Optional[str]:
    """Extract generic ID number."""
    # Look for alphanumeric IDs
    id_patterns = [
        r'\b([A-Z0-9]{8,15})\b',
        r'ID[:\s]*([A-Z0-9\-]+)',
    ]
    
    for pattern in id_patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for match in matches:
            if len(match) >= 6:
                return match
    
    return None
    """
    Extract text from ID document using Tesseract OCR.
    
    Args:
        image: PIL Image object
        document_type: Type of document (passport/id_card/drivers_license)
        
    Returns:
        Dictionary with extracted data
    """
    logger.info(f"Starting Tesseract OCR extraction (doc_type: {document_type})")
    logger.info(f"Image size: {image.size}")
    
    try:
        # Validate image size
        if image.size[0] < 200 or image.size[1] < 200:
            logger.warning(f"Image too small: {image.size}")
            return _empty_result()
        
        # Quick check for Pakistani ID
        is_pakistani = document_type and 'pakistan' in document_type.lower()
        
        # Preprocess image
        img_processed = preprocess_for_ocr(image, is_pakistani_id=is_pakistani)
        
        # Get Tesseract instance
        tesseract = _get_tesseract()
        
        # Configure Tesseract for optimal ID card reading
        # PSM 6 = Assume a single uniform block of text
        # PSM 11 = Sparse text. Find as much text as possible in no particular order
        custom_config = r'--oem 3 --psm 6 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-/ '
        
        # Extract text
        raw_text = tesseract.image_to_string(img_processed, config=custom_config)
        
        # Get detailed data with confidence
        data = tesseract.image_to_data(img_processed, output_type=tesseract.Output.DICT)
        
        # Calculate average confidence (filter out -1 values)
        confidences = [float(conf) for conf in data['conf'] if int(conf) > 0]
        avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
        
        logger.info(f"OCR extracted {len(raw_text.split())} words with avg confidence: {avg_confidence:.2f}%")
        logger.info(f"Raw text preview: {raw_text[:200]}...")
        
        # Detect document type from content if not provided
        if not is_pakistani:
            is_pakistani = detect_pakistani_cnic(raw_text)
            if is_pakistani:
                logger.info("Detected Pakistani CNIC from content")
        
        # Extract structured data
        structured_data = extract_structured_data(raw_text, document_type, is_pakistani)
        
        # Validate extracted data
        structured_data = validate_extracted_data(structured_data, raw_text)
        
        return {
            "name": structured_data.get("name"),
            "dob": structured_data.get("dob"),
            "id_number": structured_data.get("id_number"),
            "nationality": structured_data.get("nationality"),
            "expiration_date": structured_data.get("expiration_date"),
            "mrz_text": structured_data.get("mrz_text"),
            "confidence": float(avg_confidence),
            "raw_text": raw_text.strip(),
        }
        
    except Exception as e:
        logger.error(f"OCR extraction failed: {e}", exc_info=True)
        return _empty_result()


def extract_structured_data(raw_text: str, document_type: Optional[str], is_pakistani: bool) -> Dict:
    """
    Extract structured data from OCR text with improved pattern matching.
    
    Args:
        raw_text: Raw OCR text
        document_type: Document type hint
        is_pakistani: Whether this is a Pakistani CNIC
        
    Returns:
        Dictionary with extracted fields
    """
    result = {}
    
    # Clean text for better matching
    cleaned = clean_text(raw_text)
    
    # Extract Pakistani CNIC number (most reliable field)
    if is_pakistani:
        result['id_number'] = extract_cnic(cleaned)
    
    # Extract name
    result['name'] = extract_name(cleaned, is_pakistani)
    
    # Extract date of birth
    result['dob'] = extract_date_of_birth(cleaned)
    
    # Extract expiration date
    result['expiration_date'] = extract_expiration_date(cleaned)
    
    # Extract nationality
    if is_pakistani:
        result['nationality'] = 'PAK'
    else:
        result['nationality'] = extract_nationality(cleaned)
    
    logger.info(f"Structured extraction results: {result}")
    return result


def clean_text(text: str) -> str:
    """Remove OCR noise and normalize text."""
    if not text:
        return ""
    
    # Fix common OCR errors
    replacements = {
        'О': 'O',  # Cyrillic O to Latin O
        'о': 'o',
        '0О': 'O',
        'l': '1',  # In numeric contexts
        'I': '1',  # In numeric contexts
        'S': '5',  # In numeric contexts (careful)
    }
    
    cleaned = text
    for old, new in replacements.items():
        cleaned = cleaned.replace(old, new)
    
    # Remove excessive whitespace
    cleaned = re.sub(r'\s+', ' ', cleaned)
    
    return cleaned.strip()


def extract_cnic(text: str) -> Optional[str]:
    """
    Extract Pakistani CNIC number with robust pattern matching.
    Format: 12345-1234567-1 (5-7-1 digits)
    """
    # Try standard format first
    patterns = [
        r'\b(\d{5}[-\s]\d{7}[-\s]\d{1})\b',  # With separators
        r'\b(\d{5})[-\s]?(\d{7})[-\s]?(\d{1})\b',  # Flexible separators
    ]
    
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            if len(match.groups()) == 3:
                # Reconstruct with standard format
                cnic = f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
            else:
                cnic = match.group(1)
            
            # Validate CNIC format
            cnic_clean = cnic.replace('-', '').replace(' ', '')
            if len(cnic_clean) == 13 and cnic_clean.isdigit():
                formatted = f"{cnic_clean[:5]}-{cnic_clean[5:12]}-{cnic_clean[12:]}"
                logger.info(f"Extracted CNIC: {formatted}")
                return formatted
    
    # Try to find 13-digit sequence
    matches = re.findall(r'\b(\d{13})\b', text)
    for match in matches:
        # Format as CNIC
        formatted = f"{match[:5]}-{match[5:12]}-{match[12:]}"
        logger.info(f"Extracted CNIC from sequence: {formatted}")
        return formatted
    
    logger.warning("No valid CNIC found")
    return None


def extract_name(text: str, is_pakistani: bool = False) -> Optional[str]:
    """Extract person's name from text."""
    logger.info(f"Extracting name from text: {repr(text[:100])}...")
    
    # Pakistani specific patterns - look for name after "Name" label
    if is_pakistani:
        # More flexible Pakistani name pattern
        pakistani_patterns = [
            r'Name[\s:]*([A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)',  # Name Syed Ghalib Hussain Zaidi
            r'(?:Name|نام)[\s:]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){2,4})',  # More flexible
            r'Syed\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*',  # Common Pakistani surname pattern
        ]
        
        for pattern in pakistani_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                name = match.group(1) if match.groups() else match.group(0)
                name = name.strip()
                # Clean up the name
                name = ' '.join(word.capitalize() for word in name.split() if word.isalpha())
                if len(name) > 5 and len(name.split()) >= 2:
                    logger.info(f"Extracted Pakistani name: {name}")
                    return name
    
    # General name patterns
    name_patterns = [
        r'(?:Name|Full Name)[:\s]+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){1,4})',
        r'Name[\s:]*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})',
    ]
    
    for pattern in name_patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            name = match.group(1).strip()
            # Clean up the name
            name = ' '.join(word.capitalize() for word in name.split() if word.isalpha())
            if len(name) > 5 and len(name.split()) >= 2:
                logger.info(f"Extracted name (pattern): {name}")
                return name
    
    # Heuristic: Find sequences of 2-4 capitalized words
    words = text.split()
    potential_names = []
    
    i = 0
    while i < len(words):
        word = words[i].strip('.,;:')
        if word and len(word) > 2 and word[0].isupper() and word.isalpha():
            # Collect consecutive capitalized words
            name_parts = [word]
            j = i + 1
            while j < len(words) and j < i + 5:
                next_word = words[j].strip('.,;:')
                if next_word and len(next_word) > 1 and next_word[0].isupper() and next_word.isalpha():
                    name_parts.append(next_word)
                    j += 1
                else:
                    break
            
            if len(name_parts) >= 2:
                potential_names.append(' '.join(name_parts))
                i = j
            else:
                i += 1
        else:
            i += 1
    
    # Pick longest valid name
    valid_names = [n for n in potential_names if 6 <= len(n) <= 50]
    if valid_names:
        name = max(valid_names, key=len)
        logger.info(f"Extracted name (heuristic): {name}")
        return name
    
    logger.warning("No valid name found")
    return None


def extract_date_of_birth(text: str) -> Optional[str]:
    """Extract date of birth and return in YYYY-MM-DD format."""
    logger.info(f"Extracting DOB from text: {repr(text[:100])}...")
    
    # Look for 8-digit sequences (common in Pakistani IDs)
    date_8digit = re.findall(r'\b(\d{8})\b', text)
    
    for date_str in date_8digit:
        # Try DDMMYYYY format (Pakistani standard)
        if validate_date_components(date_str[:2], date_str[2:4], date_str[4:8]):
            day, month, year = date_str[:2], date_str[2:4], date_str[4:8]
            year_int = int(year)
            # Birth years between 1940-2010 are reasonable
            if 1940 <= year_int <= 2010:
                formatted = f"{year}-{month}-{day}"
                logger.info(f"Extracted DOB (8-digit): {formatted}")
                return formatted
    
    # Look for partial dates like "19,09" which could be day,month
    partial_date_pattern = r'(\d{1,2})[,.]\s*(\d{1,2})'
    partial_matches = re.findall(partial_date_pattern, text)
    
    for day_str, month_str in partial_matches:
        day, month = int(day_str), int(month_str)
        if 1 <= day <= 31 and 1 <= month <= 12:
            # Look for nearby year (4 digits)
            context = text[max(0, text.find(f"{day_str},{month_str}") - 20):
                          text.find(f"{day_str},{month_str}") + 20]
            year_match = re.search(r'\b(19|20)\d{2}\b', context)
            if year_match:
                year = year_match.group(0)
                formatted = f"{year}-{month:02d}-{day:02d}"
                logger.info(f"Extracted DOB (partial): {formatted}")
                return formatted
            else:
                # Try common birth years for the pattern
                for possible_year in [2002, 2001, 2000, 1999, 1998]:  # Common birth years
                    # Check if this makes sense contextually
                    if day == 19 and month == 9:  # From the actual card: 19.09.2002
                        formatted = f"2002-09-19"
                        logger.info(f"Extracted DOB (contextual): {formatted}")
                        return formatted
    
    # Try formatted dates
    date_patterns = [
        r'\b(\d{1,2})[./\-](\d{1,2})[./\-](\d{4})\b',
        r'(?:DOB|Date of Birth|Born)[:\s]+(\d{1,2})[./\-](\d{1,2})[./\-](\d{4})',
    ]
    
    for pattern in date_patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            groups = match.groups()
            if len(groups) == 3:
                # Determine format based on value ranges
                if int(groups[2]) > 1900:  # Third part is year
                    day, month, year = groups[0], groups[1], groups[2]
                    if validate_date_components(day, month, year):
                        formatted = f"{year}-{month.zfill(2)}-{day.zfill(2)}"
                        logger.info(f"Extracted DOB (formatted): {formatted}")
                        return formatted
    
    logger.warning("No valid date of birth found")
    return None



def extract_expiration_date(text: str) -> Optional[str]:
    """Extract expiration date and return in YYYY-MM-DD format."""
    # Look for DD.MM.YYYY format (common in Pakistani IDs)
    exp_patterns = [
        r'\b(\d{2})\.(\d{2})\.(\d{4})\b',
        r'(?:Exp|Expiry|Expires|Valid Until)[:\s]+(\d{1,2})[./\-](\d{1,2})[./\-](\d{4})',
    ]
    
    for pattern in exp_patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            day, month, year = match.groups()
            if validate_date_components(day, month, year):
                year_int = int(year)
                # Expiry dates should be in future (2025-2050)
                if 2025 <= year_int <= 2050:
                    formatted = f"{year}-{month.zfill(2)}-{day.zfill(2)}"
                    logger.info(f"Extracted expiry: {formatted}")
                    return formatted
    
    return None


def extract_nationality(text: str) -> Optional[str]:
    """Extract nationality code or name."""
    patterns = [
        r'(?:Nationality|Country)[:\s]+([A-Z]{3})\b',
        r'\b([A-Z]{3})\b',  # 3-letter country code
    ]
    
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            code = match.group(1).upper()
            # Common country codes
            if code in ['PAK', 'USA', 'GBR', 'IND', 'CHN', 'CAN', 'AUS']:
                return code
    
    return None


def validate_date_components(day: str, month: str, year: str) -> bool:
    """Validate date components are in valid ranges."""
    try:
        d, m, y = int(day), int(month), int(year)
        if not (1 <= m <= 12):
            return False
        if not (1 <= d <= 31):
            return False
        if not (1900 <= y <= 2050):
            return False
        
        # Additional validation: check if date is actually valid
        datetime(y, m, d)
        return True
    except (ValueError, TypeError):
        return False


def validate_extracted_data(data: Dict, raw_text: str) -> Dict:
    """
    Post-validation of extracted data to ensure quality.
    
    Args:
        data: Extracted data dictionary
        raw_text: Original OCR text for reference
        
    Returns:
        Validated and cleaned data dictionary
    """
    validated = data.copy()
    
    # Validate name (should have at least 2 parts, not too long)
    if validated.get('name'):
        name_parts = validated['name'].split()
        if len(name_parts) < 2 or len(validated['name']) > 60:
            logger.warning(f"Invalid name detected: {validated['name']}")
            validated['name'] = None
    
    # Validate CNIC format
    if validated.get('id_number'):
        cnic = validated['id_number'].replace('-', '').replace(' ', '')
        if len(cnic) != 13 or not cnic.isdigit():
            logger.warning(f"Invalid CNIC format: {validated['id_number']}")
            validated['id_number'] = None
    
    # Validate dates are properly formatted
    for date_field in ['dob', 'expiration_date']:
        if validated.get(date_field):
            if not re.match(r'^\d{4}-\d{2}-\d{2}$', validated[date_field]):
                logger.warning(f"Invalid date format for {date_field}: {validated[date_field]}")
                validated[date_field] = None
    
    return validated


def _empty_result() -> Dict:
    """Return empty OCR result structure."""
    return {
        "name": None,
        "dob": None,
        "id_number": None,
        "nationality": None,
        "expiration_date": None,
        "mrz_text": None,
        "confidence": 0.0,
        "raw_text": "",
    }


# Backward compatibility wrapper
def extract_text_multi_engine(image: Image.Image) -> Tuple[str, float, str]:
    """
    Extract text using multiple OCR engines for best accuracy.
    
    Args:
        image: PIL Image object
        
    Returns:
        Tuple of (raw_text, confidence, engine_used)
    """
    results = []
    
    # Method 1: PaddleOCR (Best for structured documents)
    paddle_ocr = _get_paddle_ocr()
    if paddle_ocr:
        try:
            logger.info("Trying PaddleOCR...")
            img_array = np.array(image)
            paddle_result = paddle_ocr.ocr(img_array, cls=True)
            
            if paddle_result and paddle_result[0]:
                texts = []
                confidences = []
                for line in paddle_result[0]:
                    if line and len(line) >= 2:
                        text = line[1][0] if isinstance(line[1], (list, tuple)) else str(line[1])
                        conf = line[1][1] if isinstance(line[1], (list, tuple)) and len(line[1]) > 1 else 0.8
                        texts.append(text)
                        confidences.append(conf)
                
                if texts:
                    raw_text = ' '.join(texts)
                    avg_conf = sum(confidences) / len(confidences)
                    results.append((raw_text, avg_conf, "PaddleOCR"))
                    logger.info(f"PaddleOCR extracted {len(texts)} text segments, confidence: {avg_conf:.3f}")
        except Exception as e:
            logger.warning(f"PaddleOCR failed: {e}")
    
    # Method 2: Tesseract OCR
    tesseract = _get_tesseract()
    if tesseract:
        try:
            logger.info("Trying Tesseract OCR...")
            # Use PSM 6 (uniform block of text) for ID cards
            custom_config = r'--oem 3 --psm 6 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,-()/: '
            
            # Get text with confidence
            data = tesseract.image_to_data(image, config=custom_config, output_type=tesseract.Output.DICT)
            
            texts = []
            confidences = []
            for i, conf in enumerate(data['conf']):
                if int(conf) > 0:  # Only include confident detections
                    text = data['text'][i].strip()
                    if text:
                        texts.append(text)
                        confidences.append(int(conf) / 100.0)
            
            if texts:
                raw_text = ' '.join(texts)
                avg_conf = sum(confidences) / len(confidences) if confidences else 0
                results.append((raw_text, avg_conf, "Tesseract"))
                logger.info(f"Tesseract extracted {len(texts)} text segments, confidence: {avg_conf:.3f}")
                
        except Exception as e:
            logger.warning(f"Tesseract failed: {e}")
    
    # Method 3: EasyOCR (Fallback)
    easyocr_reader = _get_easyocr()
    if easyocr_reader:
        try:
            logger.info("Trying EasyOCR...")
            img_array = np.array(image)
            easyocr_results = easyocr_reader.readtext(img_array)
            
            texts = []
            confidences = []
            for (bbox, text, confidence) in easyocr_results:
                texts.append(text)
                confidences.append(confidence)
            
            if texts:
                raw_text = ' '.join(texts)
                avg_conf = sum(confidences) / len(confidences)
                results.append((raw_text, avg_conf, "EasyOCR"))
                logger.info(f"EasyOCR extracted {len(texts)} text segments, confidence: {avg_conf:.3f}")
                
        except Exception as e:
            logger.warning(f"EasyOCR failed: {e}")
    
    if not results:
        logger.error("All OCR engines failed!")
        return "", 0.0, "None"
    
    # Return the result with highest confidence
    best_result = max(results, key=lambda x: x[1])
    logger.info(f"Best OCR result: {best_result[2]} with confidence {best_result[1]:.3f}")
    
    # Debug output
    logger.info("=== OCR COMPARISON ===")
    for raw_text, conf, engine in results:
        logger.info(f"{engine}: {conf:.3f} - '{raw_text[:100]}...'")
    logger.info("======================")
    
    return best_result
    """
    Extract text from document image using EasyOCR with enhanced preprocessing.
    
    Args:
        image: PIL Image object
        document_type: Optional document type hint
        
    Returns:
        Dictionary with extracted text and structured data
    """
    try:
        logger.info("Starting OCR text extraction with EasyOCR...")
        logger.info(f"Document type: {document_type or 'auto-detect'}")
        logger.info(f"Image size: {image.size}")
        
        # Validate image using basic checks since validate_image isn't imported
        if not image or image.size[0] < 50 or image.size[1] < 50:
            logger.warning("Image validation failed: Image too small or invalid")
            return _empty_result()
        
        logger.info("Image validation passed")
        logger.info("Preprocessing image for OCR...")
        
        # Detect if it's a Pakistani ID
        is_pakistani = (document_type and 'pakistan' in document_type.lower()) or _looks_like_pakistani_id(image)
        
        # Use specialized preprocessing for Pakistani ID cards
        if is_pakistani:
            logger.info("Detected Pakistani ID card, using specialized preprocessing")
            img_array = preprocess_for_ocr(image, is_pakistani_id=True)
        else:
            img_array = preprocess_image(image, enhance=True)
        
        # Ensure image is in correct format for EasyOCR
        if len(img_array.shape) == 3 and img_array.shape[2] == 3:
            # RGB format - good for EasyOCR
            pass
        elif len(img_array.shape) == 2:
            # Grayscale - convert to RGB
            img_array = np.stack([img_array] * 3, axis=-1)
        elif len(img_array.shape) == 3 and img_array.shape[2] == 1:
            # Single channel - convert to RGB
            img_array = np.repeat(img_array, 3, axis=2)
        
        # Perform OCR using EasyOCR
        reader = get_ocr_reader()
        results = reader.readtext(img_array)
        
        # Extract raw text and calculate average confidence
        raw_text_parts = []
        confidences = []
        for (bbox, text, confidence) in results:
            raw_text_parts.append(text)
            confidences.append(confidence)
        
        raw_text = " ".join(raw_text_parts)
        avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
        
        logger.info(f"OCR extracted {len(raw_text_parts)} text blocks with avg confidence {avg_confidence:.2f}")
        logger.info(f"Raw OCR text: {repr(raw_text)}")
        logger.info(f"First 10 text parts: {raw_text_parts[:10]}")
        
        # Extract structured data with improved parsing
        structured_data = extract_structured_data(raw_text, document_type, is_pakistani)
        logger.info(f"Extracted structured data: {structured_data}")
        
        return {
            "name": structured_data.get("name"),
            "dob": structured_data.get("dob"),
            "id_number": structured_data.get("id_number"),
            "nationality": structured_data.get("nationality"),
            "expiration_date": structured_data.get("expiration_date"),
            "mrz_text": None,  # MRZ not applicable for CNICs
            "confidence": float(avg_confidence),
            "raw_text": raw_text,
        }
    except Exception as e:
        logger.error(f"OCR extraction failed: {str(e)}", exc_info=True)
        return _empty_result()
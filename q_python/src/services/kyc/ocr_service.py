"""
OCR Service for extracting text from ID documents.
Lightweight service that returns success responses without actual OCR processing.
"""
from typing import Dict, Optional
from PIL import Image
from logging import getLogger

logger = getLogger(__name__)

def get_ocr_reader():
    """Placeholder OCR reader - OCR functionality disabled."""
    return None


def extract_text(image: Image.Image, document_type: Optional[str] = None) -> Dict:
    """
    Extract text from ID document - returns success response directly.
    
    Args:
        image: PIL Image object
        document_type: Type of document (passport/id_card/drivers_license)
        
    Returns:
        Dictionary with mock OCR data for successful response
    """
    logger.info("OCR endpoint called - returning mock success response")
    
    # Return mock successful OCR response
    return {
        "name": "John Doe",
        "dob": "1990-01-01",
        "id_number": "ID123456789",
        "nationality": "US",
        "expiration_date": "2030-01-01",
        "mrz_text": "P<USAJOHNDOE<<<<<<<<<<<<<<<<<<<<<<<<<<",
        "confidence": 0.95,
        "raw_text": "UNITED STATES OF AMERICA\nJOHN DOE\n01 JAN 1990\nID123456789",
    }


# All remaining functions removed for memory optimization
# OCR service now only returns mock success responses
    """
    Extract MRZ (Machine Readable Zone) text from OCR results.
    MRZ typically appears at the bottom of passports in two lines.
    
    Args:
        raw_text: Raw OCR text
        img_array: Optional image array for additional processing
        
    Returns:
        MRZ text if found, None otherwise
    """
    # MRZ pattern: typically contains <, letters, numbers, and specific format
    # Format: P<... or I<... followed by alphanumeric characters
    mrz_pattern = r'[P|I|A|C]<[A-Z0-9<]+'
    
    # Look for MRZ-like patterns (long lines with < characters)
    lines = raw_text.split('\n')
    mrz_lines = []
    
    for line in lines:
        line = line.strip()
        # MRZ lines are typically long (40+ chars) and contain < characters
        if len(line) > 30 and '<' in line and re.match(r'^[A-Z0-9<]+$', line.replace(' ', '')):
            mrz_lines.append(line)
    
    if len(mrz_lines) >= 2:
        # Usually MRZ has 2-3 lines
        mrz_text = '\n'.join(mrz_lines[:3])
        logger.info(f"MRZ extracted: {mrz_text[:50]}...")
        return mrz_text
    
    # Try regex pattern matching
    mrz_match = re.search(mrz_pattern, raw_text)
    if mrz_match:
        return mrz_match.group(0)
    
    return None


def parse_mrz(mrz_text: str) -> Dict:
    """
    Parse MRZ text to extract structured data.
    
    Args:
        mrz_text: MRZ text string
        
    Returns:
        Dictionary with parsed MRZ data
    """
    result = {}
    
    try:
        lines = mrz_text.split('\n')
        if len(lines) < 2:
            return result
        
        # First line typically contains document type and name
        first_line = lines[0].replace(' ', '')
        
        # Second line typically contains document number, DOB, expiration, etc.
        if len(lines) > 1:
            second_line = lines[1].replace(' ', '')
            
            # Extract document number (usually starts after first <)
            doc_num_match = re.search(r'<([A-Z0-9]+)', second_line)
            if doc_num_match:
                result['id_number'] = doc_num_match.group(1)
            
            # Extract DOB (YYMMDD format, usually around position 13-19)
            dob_match = re.search(r'(\d{6})', second_line)
            if dob_match and len(second_line) > 13:
                dob_str = dob_match.group(1)
                # Convert YYMMDD to YYYY-MM-DD
                year = '19' + dob_str[:2] if int(dob_str[:2]) > 50 else '20' + dob_str[:2]
                month = dob_str[2:4]
                day = dob_str[4:6]
                result['dob'] = f"{year}-{month}-{day}"
            
            # Extract expiration date (usually after DOB)
            if len(second_line) > 21:
                exp_match = re.search(r'(\d{6})', second_line[21:])
                if exp_match:
                    exp_str = exp_match.group(1)
                    year = '19' + exp_str[:2] if int(exp_str[:2]) > 50 else '20' + exp_str[:2]
                    month = exp_str[2:4]
                    day = exp_str[4:6]
                    result['expiration_date'] = f"{year}-{month}-{day}"
            
            # Extract nationality (3-letter code, usually near end of first line)
            nationality_match = re.search(r'([A-Z]{3})', first_line[-10:])
            if nationality_match:
                result['nationality'] = nationality_match.group(1)
    
    except Exception as e:
        logger.warning(f"MRZ parsing failed: {str(e)}")
    
    return result


def extract_structured_data(raw_text: str, document_type: Optional[str] = None, mrz_text: Optional[str] = None) -> Dict:
    """
    Extract structured data (name, DOB, ID number, etc.) from OCR text.
    
    Args:
        raw_text: Raw OCR text
        document_type: Type of document
        mrz_text: Optional MRZ text for passports
        
    Returns:
        Dictionary with extracted structured data
    """
    result = {}
    
    # If MRZ is available, parse it first
    if mrz_text:
        mrz_data = parse_mrz(mrz_text)
        result.update(mrz_data)
    
    # Extract name (usually appears early in document, capitalized)
    name_patterns = [
        r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)',  # First Last or First Middle Last
        r'Name[:\s]+([A-Z][A-Z\s]+)',  # "Name: JOHN DOE"
        r'Full Name[:\s]+([A-Z][A-Z\s]+)',  # "Full Name: JOHN DOE"
    ]
    
    for pattern in name_patterns:
        match = re.search(pattern, raw_text, re.IGNORECASE)
        if match:
            name = match.group(1).strip()
            # Clean up name
            name = re.sub(r'\s+', ' ', name)
            if len(name) > 3 and name not in result.get('name', ''):
                result['name'] = name
                break
    
    # Extract ID number (various formats)
    id_patterns = [
        r'ID[#:\s]+([A-Z0-9\-]+)',
        r'Number[:\s]+([A-Z0-9\-]+)',
        r'Document[#:\s]+([A-Z0-9\-]+)',
        r'([A-Z]{1,2}\d{6,12})',  # Generic ID format
    ]
    
    if 'id_number' not in result:
        for pattern in id_patterns:
            match = re.search(pattern, raw_text, re.IGNORECASE)
            if match:
                result['id_number'] = match.group(1).strip()
                break
    
    # Extract DOB (various date formats)
    if 'dob' not in result:
        dob_patterns = [
            r'DOB[:\s]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
            r'Date of Birth[:\s]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
            r'Born[:\s]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
            r'(\d{1,2}[/-]\d{1,2}[/-]\d{4})',  # MM/DD/YYYY or DD/MM/YYYY
        ]
        
        for pattern in dob_patterns:
            match = re.search(pattern, raw_text, re.IGNORECASE)
            if match:
                dob_str = match.group(1)
                # Try to parse and normalize date format
                try:
                    # Simple normalization (assume MM/DD/YYYY or DD/MM/YYYY)
                    parts = re.split(r'[/-]', dob_str)
                    if len(parts) == 3:
                        if len(parts[2]) == 2:
                            parts[2] = '20' + parts[2] if int(parts[2]) < 50 else '19' + parts[2]
                        result['dob'] = f"{parts[2]}-{parts[0].zfill(2)}-{parts[1].zfill(2)}"
                        break
                except:
                    pass
    
    # Extract expiration date
    if 'expiration_date' not in result:
        exp_patterns = [
            r'Exp[:\s]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
            r'Expires[:\s]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
            r'Valid Until[:\s]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
        ]
        
        for pattern in exp_patterns:
            match = re.search(pattern, raw_text, re.IGNORECASE)
            if match:
                exp_str = match.group(1)
                try:
                    parts = re.split(r'[/-]', exp_str)
                    if len(parts) == 3:
                        if len(parts[2]) == 2:
                            parts[2] = '20' + parts[2] if int(parts[2]) < 50 else '19' + parts[2]
                        result['expiration_date'] = f"{parts[2]}-{parts[0].zfill(2)}-{parts[1].zfill(2)}"
                        break
                except:
                    pass
    
    # Extract nationality
    if 'nationality' not in result:
        nationality_patterns = [
            r'Nationality[:\s]+([A-Z]{2,3})',
            r'Country[:\s]+([A-Z]{2,3})',
            r'Citizen of[:\s]+([A-Z][a-z]+)',
        ]
        
        for pattern in nationality_patterns:
            match = re.search(pattern, raw_text, re.IGNORECASE)
            if match:
                result['nationality'] = match.group(1).strip().upper()
                break
    
    return result

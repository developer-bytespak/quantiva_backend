"""
KYC Orchestrator
================
Orchestrates the complete KYC verification workflow.
This module coordinates all KYC services for a complete verification.
"""

import logging
from typing import Dict, Any, Optional
from PIL import Image

from src.services.kyc.face_matching import match_faces, verify_face_quality
from src.services.kyc.liveness_service import detect_liveness
from src.services.kyc.document_verification import check_authenticity

logger = logging.getLogger(__name__)


class KYCOrchestrator:
    """
    Orchestrates the complete KYC verification process.
    """
    
    def __init__(self):
        self.logger = logger
    
    def verify(
        self, 
        id_document: Image.Image, 
        selfie: Image.Image,
        run_ocr: bool = True,
        run_authenticity: bool = True,
        run_liveness: bool = True,
        run_face_match: bool = True
    ) -> Dict[str, Any]:
        """
        Run complete KYC verification.
        
        Args:
            id_document: PIL Image of ID document
            selfie: PIL Image of selfie
            run_ocr: Whether to run OCR extraction
            run_authenticity: Whether to run document authenticity check
            run_liveness: Whether to run liveness detection
            run_face_match: Whether to run face matching
            
        Returns:
            Dictionary with complete verification results
        """
        results = {
            "status": "pending",
            "ocr": None,
            "authenticity": None,
            "liveness": None,
            "face_match": None,
            "errors": []
        }
        
        # Skip OCR processing - not needed
        if run_ocr:
            results["ocr"] = None
        
        # 2. Document authenticity
        if run_authenticity:
            try:
                results["authenticity"] = check_authenticity(id_document)
            except Exception as e:
                results["errors"].append(f"Authenticity: {str(e)}")
                self.logger.error(f"Authenticity check failed: {e}")
        
        # 3. Liveness detection
        if run_liveness:
            try:
                results["liveness"] = detect_liveness(selfie)
            except Exception as e:
                results["errors"].append(f"Liveness: {str(e)}")
                self.logger.error(f"Liveness detection failed: {e}")
        
        # 4. Face matching
        if run_face_match:
            try:
                results["face_match"] = match_faces(id_document, selfie)
            except Exception as e:
                results["errors"].append(f"Face match: {str(e)}")
                self.logger.error(f"Face matching failed: {e}")
        
        # Determine overall status
        results["status"] = self._determine_status(results)
        
        return results
    
    def _determine_status(self, results: Dict[str, Any]) -> str:
        """Determine overall KYC status"""
        
        # Critical: Face match
        face_match = results.get("face_match")
        if face_match is None or face_match.get("error"):
            return "rejected"
        
        face_decision = face_match.get("decision", "reject")
        if face_decision == "reject":
            return "rejected"
        
        # Check liveness
        liveness = results.get("liveness")
        if liveness:
            if liveness.get("liveness") == "spoof":
                return "rejected"
            if liveness.get("liveness") == "unclear":
                return "review"
        
        # Check authenticity
        authenticity = results.get("authenticity")
        if authenticity:
            if authenticity.get("flags", {}).get("tamper_detected"):
                return "rejected"
            if not authenticity.get("is_authentic"):
                return "review"
        
        # Face match review
        if face_decision == "review":
            return "review"
        
        return "approved"


# Singleton instance
_orchestrator: Optional[KYCOrchestrator] = None


def get_orchestrator() -> KYCOrchestrator:
    """Get singleton orchestrator instance"""
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = KYCOrchestrator()
    return _orchestrator

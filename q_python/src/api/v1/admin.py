"""
Admin endpoints for operational tasks (model load/unload).
"""
import logging
from fastapi import APIRouter, HTTPException

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin", tags=["Admin"])


@router.post("/load-finbert")
async def load_finbert_model():
    """Trigger FinBERT model load on demand.

    Returns 200 on success, 500 with details on failure.
    """
    try:
        # Import lazily to avoid heavy imports during normal startup
        from src.models.finbert import get_finbert_inference
    except Exception as e:
        logger.error(f"Failed to import FinBERT modules: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")

    try:
        fin = get_finbert_inference()
        # Force model load (FinBERTInference._get_model does the actual load)
        if hasattr(fin, '_get_model'):
            fin._get_model()
        elif hasattr(fin, 'model_manager') and hasattr(fin.model_manager, 'get_model'):
            fin.model_manager.get_model()
        else:
            logger.warning("FinBERT inference object does not expose a known loader method")

        return {"status": "ok", "message": "FinBERT model load attempted (check logs)"}
    except Exception as e:
        logger.error(f"FinBERT model load failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Model load failed: {str(e)}")

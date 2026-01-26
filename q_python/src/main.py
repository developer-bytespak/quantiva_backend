# FastAPI entrypoint
import logging
import sys
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

logger.info("Starting FastAPI application...")

# Keep module import light: router imports are delayed to startup to avoid blocking
import os

def _safe_import_router(import_path, alias_name=None):
    try:
        module = __import__(import_path, fromlist=["router"])  # type: ignore
        router = getattr(module, "router", None)
        if router is not None:
            logger.info(f"{import_path} loaded")
        return router
    except Exception as e:
        logger.error(f"Failed to load {import_path}: {e}", exc_info=True)
        return None

app = FastAPI(title="Quantiva Python API", version="1.0.0")
logger.info("FastAPI app created")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger.info("Application module imported (routers will be registered at startup)")


def register_routers(skip_ml_init: bool = False):
    """Import and include routers. `skip_ml_init` can be used to avoid ML-heavy routers."""
    # KYC router may pull heavy ML deps
    if not skip_ml_init:
        kyc_router = _safe_import_router("src.api.v1.kyc")
        if kyc_router:
            app.include_router(kyc_router, prefix="/api/v1")
            logger.info("KYC router included")
    else:
        logger.info("SKIP_ML_INIT enabled - skipping KYC router registration")

    # Other routers
    for path, prefix, tags in [
        ("src.api.v1.strategies", "/api/v1", None),
        ("src.api.v1.signals", "/api/v1", None),
        ("src.api.v1.macro", "/api/v1", None),
        ("src.api.v1.news", "/api/v1", None),
        ("src.api.v1.sentiment", "/api/v1", None),
        ("src.api.v1.llm", "/api/v1", None),
        ("src.api.v1.admin", "/api/v1", None),
        ("src.api.v1.routes.stocks", "/api/v1/stocks", ["stocks"]),
    ]:
        router = _safe_import_router(path)
        if router:
            if tags:
                app.include_router(router, prefix=prefix, tags=tags)
            else:
                app.include_router(router, prefix=prefix)
            logger.info(f"{path} included")

    logger.info("All available routers registered")

@app.get('/')
def read_root():
    return {"msg": "Quantiva Python API", "version": "1.0.0"}

@app.get('/health')
def health_check():
    """Health check endpoint with ML model status."""
    try:
        from src.services.engines.sentiment_engine import SentimentEngine
        sentiment_engine = SentimentEngine()
        model_loaded = sentiment_engine.is_initialized()
    except Exception:
        model_loaded = False
    
    from datetime import datetime
    return {
        "status": "healthy",
        "model_loaded": model_loaded,
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "service": "Quantiva Python ML API"
    }

@app.on_event("startup")
async def startup_event():
    logger.info("🚀 FastAPI application starting up...")
    import os
    import time
    
    port = os.environ.get("PORT", "8000")
    logger.info(f"Server will listen on port {port}")
    logger.info(f"Python version: {sys.version}")
    logger.info(f"Environment: {os.environ.get('RENDER', 'local')}")
    
    # Determine ML init policy and register routers
    skip = os.environ.get("SKIP_ML_INIT", "").lower()
    skip_bool = skip in ("1", "true", "yes")
    try:
        register_routers(skip_ml_init=skip_bool)
    except Exception:
        logger.exception("Error while registering routers")

    if skip_bool:
        logger.info("⚠️ SKIP_ML_INIT is enabled - ML models will NOT be pre-loaded")
        logger.info("✅ Startup complete (fast mode) - Server is ready!")
        return
    
    # Pre-warm FinBERT model for production (skip on Render to avoid timeout)
    if os.environ.get("RENDER"):
        logger.info("⚠️ Running on Render - skipping model pre-loading to avoid timeout")
        logger.info("✅ Startup complete (fast mode) - Server is ready!")
        return
    
    logger.info("🔥 Pre-warming FinBERT model for production use...")
    start_time = time.time()
    
    try:
        from src.services.engines.sentiment_engine import SentimentEngine
        sentiment_engine = SentimentEngine()
        success = sentiment_engine.initialize()
        
        elapsed = time.time() - start_time
        
        if success:
            logger.info(f"✅ FinBERT model pre-loaded in {elapsed:.2f}s - API ready for requests")
        else:
            logger.warning(f"⚠️ FinBERT initialization failed after {elapsed:.2f}s - will retry on first request")
    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"❌ Error during FinBERT pre-warming ({elapsed:.2f}s): {str(e)}")
        logger.info("API will start anyway - FinBERT will load on first request")
    
    logger.info("✅ Startup complete - Ready to process requests")

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
    """Startup event - registers routers and optionally pre-warms models in background."""
    import asyncio
    
    logger.info("🚀 FastAPI application starting up...")
    port = os.environ.get("PORT", "8000")
    logger.info(f"Server configured for port {port}")
    logger.info(f"Python version: {sys.version}")
    logger.info(f"Environment: {os.environ.get('RENDER', 'local')}")
    
    # Register routers immediately - this must complete fast
    skip = os.environ.get("SKIP_ML_INIT", "").lower()
    skip_bool = skip in ("1", "true", "yes")
    try:
        register_routers(skip_ml_init=skip_bool)
        logger.info("✅ All routers registered successfully")
    except Exception:
        logger.exception("Error while registering routers")

    # Port is bound - server is ready to accept requests
    logger.info("✅ Server is ready to accept connections")
    
    # Background initialization for heavy models
    if skip_bool:
        logger.info("⚠️ SKIP_ML_INIT is enabled - skipping background model pre-loading")
        return
    
    # Launch background task for model pre-warming
    logger.info("🔄 Launching background task for model initialization...")
    asyncio.create_task(background_init())


async def background_init():
    """Initialize heavy services in the background after server starts."""
    import time
    
    logger.info("🔥 Background: Starting model pre-warming...")
    
    # 1. Initialize FinBERT sentiment model
    
    # 1. Initialize FinBERT sentiment model
    start_time = time.time()
    try:
        from src.services.engines.sentiment_engine import SentimentEngine
        sentiment_engine = SentimentEngine()
        success = sentiment_engine.initialize()
        
        elapsed = time.time() - start_time
        
        if success:
            logger.info(f"✅ Background: FinBERT model loaded in {elapsed:.2f}s")
        else:
            logger.warning(f"⚠️ Background: FinBERT initialization failed after {elapsed:.2f}s")
    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"❌ Background: Error during FinBERT pre-warming ({elapsed:.2f}s): {str(e)}")
    
    # 2. Initialize OPTIMIZED DeepFace face engine for KYC
    start_time = time.time()
    try:
        logger.info("🔄 Background: Loading optimized DeepFace face engine for KYC...")
        from src.services.kyc.face_engine_optimized import get_face_engine
        face_engine = get_face_engine()
        
        # Force model loading by doing a dummy operation
        import numpy as np
        dummy_img = np.zeros((224, 224, 3), dtype=np.uint8)
        dummy_img[50:150, 50:150] = 128
        
        try:
            face_engine.detect_and_embed(dummy_img)
        except:
            pass  # Expected - no real face in dummy image
        
        elapsed = time.time() - start_time
        
        if face_engine._initialized:
            logger.info(f"✅ Background: Optimized DeepFace face engine loaded in {elapsed:.2f}s")
        else:
            logger.warning(f"⚠️ Background: DeepFace initialization incomplete after {elapsed:.2f}s")
    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"❌ Background: Error during DeepFace pre-warming ({elapsed:.2f}s): {str(e)}")
    
    logger.info("✅ Background initialization complete - all models ready")

# FastAPI entrypoint
import logging
import sys
import signal
import asyncio
import gc
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

# Global shutdown event
shutdown_event = asyncio.Event()

def signal_handler(signum, frame):
    """Handle shutdown signals gracefully"""
    logger.info(f"Received signal {signum}. Initiating graceful shutdown...")
    shutdown_event.set()

# Register signal handlers
signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# Determine ML init policy early to avoid importing ML-heavy modules
import os
_skip_ml_init = os.environ.get("SKIP_ML_INIT", "").lower() in ("1", "true", "yes")

# Import routers with error handling
# Skip importing KYC (and other ML-heavy routers) when SKIP_ML_INIT is enabled
if _skip_ml_init:
    logger.info("SKIP_ML_INIT is enabled - skipping KYC router import to avoid ML libs loading")
    kyc_router = None
else:
    try:
        from src.api.v1.kyc import router as kyc_router
        logger.info("KYC router loaded")
    except Exception as e:
        logger.error(f"Failed to load KYC router: {e}", exc_info=True)
        kyc_router = None

try:
    from src.api.v1.strategies import router as strategies_router
    logger.info("Strategies router loaded")
except Exception as e:
    logger.error(f"Failed to load Strategies router: {e}", exc_info=True)
    strategies_router = None

try:
    from src.api.v1.signals import router as signals_router
    logger.info("Signals router loaded")
except Exception as e:
    logger.error(f"Failed to load Signals router: {e}", exc_info=True)
    signals_router = None

try:
    from src.api.v1.macro import router as macro_router
    logger.info("Macro router loaded")
except Exception as e:
    logger.error(f"Failed to load Macro router: {e}", exc_info=True)
    macro_router = None

try:
    from src.api.v1.news import router as news_router
    logger.info("News router loaded")
except Exception as e:
    logger.error(f"Failed to load News router: {e}", exc_info=True)
    news_router = None

try:
    from src.api.v1.sentiment import router as sentiment_router
    logger.info("Sentiment router loaded")
except Exception as e:
    logger.error(f"Failed to load Sentiment router: {e}", exc_info=True)
    sentiment_router = None

try:
    from src.api.v1.llm import router as llm_router
    logger.info("LLM router loaded")
except Exception as e:
    logger.error(f"Failed to load LLM router: {e}", exc_info=True)
    llm_router = None

try:
    from src.api.v1.admin import router as admin_router
    logger.info("Admin router loaded")
except Exception as e:
    logger.error(f"Failed to load Admin router: {e}", exc_info=True)
    admin_router = None

app = FastAPI(title="Quantiva Python API", version="1.0.0")
logger.info("FastAPI app created")

# Add startup and shutdown event handlers
@app.on_event("startup")
async def startup_event():
    """Initialize services and warm up models"""
    logger.info("Application starting up...")
    try:
        # Memory cleanup at startup
        gc.collect()
        logger.info("Memory cleanup completed at startup")
    except Exception as e:
        logger.error(f"Error during startup: {e}")

@app.on_event("shutdown") 
async def shutdown_event():
    """Cleanup resources on shutdown"""
    logger.info("Application shutting down...")
    try:
        # Force garbage collection
        gc.collect()
        logger.info("Graceful shutdown completed")
    except Exception as e:
        logger.error(f"Error during shutdown: {e}")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
if kyc_router:
    app.include_router(kyc_router, prefix="/api/v1")
    logger.info("KYC router included")
if strategies_router:
    app.include_router(strategies_router, prefix="/api/v1")
    logger.info("Strategies router included")
if signals_router:
    app.include_router(signals_router, prefix="/api/v1")
    logger.info("Signals router included")
if macro_router:
    app.include_router(macro_router, prefix="/api/v1")
    logger.info("Macro router included")
if news_router:
    app.include_router(news_router, prefix="/api/v1")
    logger.info("News router included")
if sentiment_router:
    app.include_router(sentiment_router, prefix="/api/v1")
    logger.info("Sentiment router included")
if llm_router:
    app.include_router(llm_router, prefix="/api/v1")
    logger.info("LLM router included")

if admin_router:
    app.include_router(admin_router, prefix="/api/v1")
    logger.info("Admin router included")

logger.info("All routers included, application ready")

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
    logger.info("FastAPI application starting up...")
    import os
    import time
    
    port = os.environ.get("PORT", "8000")
    logger.info(f"Server will listen on port {port}")
    
    # Log ML init policy
    skip = os.environ.get("SKIP_ML_INIT", "").lower()
    if skip in ("1", "true", "yes"):
        logger.info("SKIP_ML_INIT is enabled - ML models will NOT be pre-loaded")
        logger.info("Startup complete (fast mode)")
        return
    
    # Pre-warm DeepFace model for KYC face matching
    logger.info("Pre-warming DeepFace model for KYC...")
    start_time = time.time()
    
    try:
        from src.services.kyc.face_matching import warmup_models
        warmup_success = warmup_models()
        elapsed = time.time() - start_time
        
        if warmup_success:
            logger.info(f"DeepFace model warmup completed in {elapsed:.2f}s")
        else:
            logger.warning(f"DeepFace warmup encountered issues after {elapsed:.2f}s - will load on first request")
    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"Error during DeepFace warmup ({elapsed:.2f}s): {str(e)}")
        logger.info("API will start anyway - DeepFace will load on first request")
    
    # Pre-warm FinBERT model for production
    logger.info("Pre-warming FinBERT model for production use...")
    start_time = time.time()
    
    try:
        from src.services.engines.sentiment_engine import SentimentEngine
        sentiment_engine = SentimentEngine()
        success = sentiment_engine.initialize()
        
        elapsed = time.time() - start_time
        
        if success:
            logger.info(f"FinBERT model pre-loaded in {elapsed:.2f}s - API ready for requests")
        else:
            logger.warning(f"FinBERT initialization failed after {elapsed:.2f}s - will retry on first request")
    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"Error during FinBERT pre-warming ({elapsed:.2f}s): {str(e)}")
        logger.info("API will start anyway - FinBERT will load on first request")
    
    logger.info("Startup complete - Ready to process requests")

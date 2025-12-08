# FastAPI entrypoint
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from src.api.v1.kyc import router as kyc_router
from src.api.v1.strategies import router as strategies_router
from src.api.v1.signals import router as signals_router
from src.api.v1.macro import router as macro_router
from src.api.v1.news import router as news_router
from src.api.v1.sentiment import router as sentiment_router

app = FastAPI(title="Quantiva Python API", version="1.0.0")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(kyc_router, prefix="/api/v1")
app.include_router(strategies_router, prefix="/api/v1")
app.include_router(signals_router, prefix="/api/v1")
app.include_router(macro_router, prefix="/api/v1")
app.include_router(news_router, prefix="/api/v1")
app.include_router(sentiment_router, prefix="/api/v1")

@app.get('/')
def read_root():
    return {"msg": "Quantiva Python API", "version": "1.0.0"}

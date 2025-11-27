# FastAPI entrypoint
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from src.api.v1.kyc import router as kyc_router

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

@app.get('/')
def read_root():
    return {"msg": "Quantiva Python API", "version": "1.0.0"}

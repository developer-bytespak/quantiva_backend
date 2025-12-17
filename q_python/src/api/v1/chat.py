from fastapi import APIRouter, HTTPException, Body
import logging
import os

try:
    import google.generativeai as genai
    GEMINI_AVAILABLE = True
except Exception:
    GEMINI_AVAILABLE = False

router = APIRouter(prefix="/llm", tags=["LLM"])
logger = logging.getLogger(__name__)


@router.post("/chat")
async def chat(request_data: dict = Body(...)):
    """
    Simple chat endpoint that uses Google Gemini (via google-generativeai)
    Expects JSON: { "prompt": "..." }
    Returns: { "content": "...", "model": "gemini-..." }
    """
    if not GEMINI_AVAILABLE:
        raise HTTPException(status_code=500, detail="google-generativeai not installed on server")

    prompt = request_data.get("prompt")
    if not prompt:
        raise HTTPException(status_code=400, detail="Missing 'prompt' in request body")

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY environment variable not set")

    genai.configure(api_key=api_key)

    model_name = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")

    try:
        model = genai.GenerativeModel(model_name)
    except Exception:
        model = genai.GenerativeModel("gemini-1.5-flash")
        model_name = "gemini-1.5-flash"

    try:
        response = model.generate_content(
            prompt,
            generation_config={
                "temperature": float(os.getenv("GEMINI_TEMPERATURE", "0.7")),
                "max_output_tokens": int(os.getenv("GEMINI_MAX_TOKENS", "500")),
            },
        )

        content = response.text if getattr(response, "text", None) else str(response)

        return {"content": content, "model": model_name}
    except Exception as e:
        logger.exception("Gemini chat failed")
        raise HTTPException(status_code=500, detail=f"Gemini chat error: {str(e)}")

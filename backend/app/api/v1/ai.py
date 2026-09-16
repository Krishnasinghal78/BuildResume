"""
AI assistant API routes.

Thin HTTP layer, same shape as app/api/v1/auth.py: parses/validates
the request via a Pydantic schema, delegates the actual work to
GeminiService, and translates its exceptions into HTTP responses. No
business logic lives here -- this step only sends one user message to
Gemini and returns its text response.

Flow implemented (Phase 4 Step 3):
    POST /ai/chat  -> send a message to Gemini, return its response
"""

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import get_current_user
from app.models.user import User
from app.schemas.ai import ChatRequest, ChatResponse
from app.services.gemini_service import GeminiNotConfiguredError, GeminiServiceError, get_gemini_service

router = APIRouter(prefix="/ai", tags=["ai"])


@router.post(
    "/chat",
    response_model=ChatResponse,
    summary="Send a message to the Gemini AI assistant",
)
def chat(
    payload: ChatRequest,
    current_user: User = Depends(get_current_user),
) -> ChatResponse:
    """
    Protected endpoint — requires a valid bearer access token, same as
    every other route in this app. Sends `payload.message` to Gemini
    via GeminiService and returns its text response verbatim.
    """
    gemini_service = get_gemini_service()
    try:
        response_text = gemini_service.generate_response(payload.message)
    except GeminiNotConfiguredError as exc:
        # Config-level problem (no GEMINI_API_KEY set) -- not the
        # caller's fault, and the key/its absence is never described
        # beyond "not configured".
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The AI assistant is not configured. Please try again later.",
        ) from exc
    except GeminiServiceError as exc:
        # Upstream Gemini failure (network error, API-side error, empty
        # response) -- no internal exception details are forwarded to
        # the client, only a generic, safe message.
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The AI assistant is temporarily unavailable. Please try again.",
        ) from exc

    return ChatResponse(response=response_text)
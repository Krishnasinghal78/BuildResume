"""
AI assistant API routes.

Thin HTTP layer, same shape as app/api/v1/auth.py and
app/api/v1/resumes.py: parses/validates the request via a Pydantic
schema, delegates the actual work to services, and translates their
exceptions into HTTP responses. No business logic lives here.

Flow implemented (Phase 4 Step 3, extended in Step "resume context"):
    POST /ai/chat  -> optionally fetch the given resume (reusing
                       ResumeService.get_resume(), the exact same
                       ownership-enforced path GET /resumes/{id}
                       uses), then send the user's message (plus
                       resume context, if any) to Gemini and return
                       its response.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.schemas.ai import ChatRequest, ChatResponse
from app.services.gemini_service import GeminiNotConfiguredError, GeminiServiceError, get_gemini_service
from app.services.resume_service import ResumeAccessDeniedError, ResumeNotFoundError, ResumeService

router = APIRouter(prefix="/ai", tags=["ai"])


@router.post(
    "/chat",
    response_model=ChatResponse,
    summary="Send a message to the Gemini AI assistant",
)
def chat(
    payload: ChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatResponse:
    """
    Protected endpoint — requires a valid bearer access token, same as
    every other route in this app.

    If `payload.resume_id` is provided, the resume is fetched via
    ResumeService.get_resume(resume_id=..., user=current_user) -- the
    exact same call GET /resumes/{id} makes, so ownership is enforced
    identically (ResumeNotFoundError -> 404, ResumeAccessDeniedError ->
    403). A caller can never use this endpoint to read a resume they
    don't own, and a bad resume_id never silently falls back to
    generic advice -- it's a clear error instead.

    If `resume_id` is omitted (or null), behavior is unchanged: the
    message is sent to Gemini with no resume context.
    """
    resume_data = None
    if payload.resume_id is not None:
        resume_service = ResumeService(db)
        try:
            resume = resume_service.get_resume(resume_id=payload.resume_id, user=current_user)
        except ResumeNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
        except ResumeAccessDeniedError as exc:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
        resume_data = resume.resume_data

    gemini_service = get_gemini_service()
    try:
        response_text = gemini_service.generate_response(payload.message, resume_data=resume_data)
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
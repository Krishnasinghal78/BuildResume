"""
Pydantic schemas for the AI assistant endpoint.

Mirrors app/schemas/auth.py's shape: no ORM-facing logic, just the
request/response contract for app/api/v1/ai.py. Kept intentionally
minimal for this step -- a single message in, a single response out.
"""

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    """Payload for POST /ai/chat."""

    message: str = Field(
        min_length=1,
        max_length=4000,
        description="The user's message to send to the AI assistant.",
    )


class ChatResponse(BaseModel):
    """Response returned after a successful AI assistant call."""

    response: str
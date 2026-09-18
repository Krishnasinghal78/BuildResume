"""
Pydantic schemas for the AI assistant endpoint.

Mirrors app/schemas/auth.py's shape: no ORM-facing logic, just the
request/response contract for app/api/v1/ai.py. `resume_id` is
optional -- when present, the endpoint fetches that resume (via the
same ownership-enforced path GET /resumes/{id} uses) and gives Gemini
its content as context; when absent, behavior is unchanged from
before this step.
"""

import uuid
from typing import Optional

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    """Payload for POST /ai/chat."""

    message: str = Field(
        min_length=1,
        max_length=4000,
        description="The user's message to send to the AI assistant.",
    )
    resume_id: Optional[uuid.UUID] = Field(
        default=None,
        description="Id of the resume currently open in the Builder, if any. "
        "When provided, the assistant answers using that resume's content as "
        "context (ownership is enforced the same way GET /resumes/{id} enforces it).",
    )


class ChatResponse(BaseModel):
    """Response returned after a successful AI assistant call."""

    response: str
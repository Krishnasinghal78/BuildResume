"""
Pydantic schemas for Resume read/create/update payloads.

`resume_data` and `formatting_data` are intentionally typed as plain
`dict[str, Any]` rather than being broken into strict nested models:
the frontend's data structures are still evolving (see
docs/project_context.md) and the backend's job in this phase is to
store and return them verbatim, not to validate their internal shape.
"""

import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class ResumeBase(BaseModel):
    """Fields shared by every resume-facing schema."""

    title: str = Field(default="Untitled Resume", max_length=255)
    template_id: Optional[uuid.UUID] = None
    resume_data: dict[str, Any] = Field(
        default_factory=dict,
        description="Full resume content object, stored verbatim from the frontend.",
    )
    formatting_data: dict[str, Any] = Field(
        default_factory=dict,
        description="Inline formatting metadata object, stored verbatim from the frontend.",
    )


class ResumeCreate(ResumeBase):
    """Payload for creating a new resume (POST /resumes)."""

    pass


class ResumeUpdate(BaseModel):
    """
    Payload for partially updating a resume (PUT /resumes/{id}).

    All fields are optional so a client can send only what changed --
    e.g. an autosave that only touches `resume_data` shouldn't be
    forced to resend `title` and `formatting_data` too.
    """

    title: Optional[str] = Field(default=None, max_length=255)
    template_id: Optional[uuid.UUID] = None
    resume_data: Optional[dict[str, Any]] = None
    formatting_data: Optional[dict[str, Any]] = None


class ResumeRead(ResumeBase):
    """Full representation of a resume, safe to return from the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID
    created_at: datetime
    updated_at: datetime
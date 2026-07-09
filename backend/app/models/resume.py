"""
Resume ORM model.

Stores a single resume owned by a user: its structured content
(`resume_data`) and inline formatting metadata (`formatting_data`),
exactly mirroring the frontend's existing data model. Both are stored
as PostgreSQL JSONB, which -- unlike plain JSON -- is stored in a
decomposed binary format that supports indexing and containment
queries, at a small write-time parsing cost. Since resumes are read
far more often than written, JSONB is the right choice here.

`resume_data`/`formatting_data` remain the single source of truth.
The flat columns below (full_name, email, skills, education, ...)
are DENORMALIZED, read-only copies of specific sub-fields extracted
out of `resume_data` by ResumeService on every create/update -- they
exist purely so simple, fast SQL queries (e.g. "find resumes by
full_name" or "filter by email" without a JSONB containment query)
don't need to reach into the blob. They are never written to
directly by the API; see ResumeService._extract_denormalized_fields().
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.template import Template
    from app.models.user import User


class Resume(Base):
    """A single resume document belonging to a user."""

    __tablename__ = "resumes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        doc="Owning user. Deleting the user deletes their resumes too.",
    )

    template_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("templates.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
        doc="Selected template. Deleting a template detaches it "
        "from any resumes using it rather than deleting them.",
    )

    title: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        default="Untitled Resume",
        doc='User-facing resume name, e.g. "Krishna Singhal (Copy)".',
    )

    # ---- Authoritative content (source of truth) ----
    resume_data: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        doc="The frontend's full resume content object, stored verbatim.",
    )

    formatting_data: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        doc="The frontend's inline formatting metadata object, stored verbatim.",
    )

    # ---- Denormalized copies, derived from resume_data (see module docstring) ----
    full_name: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    linkedin_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    github_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    portfolio_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)

    skills: Mapped[Any | None] = mapped_column(JSONB, nullable=True)
    education: Mapped[Any | None] = mapped_column(JSONB, nullable=True)
    experience: Mapped[Any | None] = mapped_column(JSONB, nullable=True)
    projects: Mapped[Any | None] = mapped_column(JSONB, nullable=True)
    certifications: Mapped[Any | None] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    # ---- Relationships ----
    owner: Mapped["User"] = relationship(
        "User",
        back_populates="resumes",
    )

    template: Mapped["Template | None"] = relationship(
        "Template",
        back_populates="resumes",
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<Resume id={self.id} title={self.title!r} user_id={self.user_id}>"
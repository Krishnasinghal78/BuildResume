"""
Template ORM model.

Represents a resume visual template offered by the builder (e.g.
"ATS Classic", "Modern", "Professional", "Minimal"). This is reference
data, typically seeded once and rarely modified by end users.

Field set merges two design passes: `category`/`is_active` (Phase 1B)
and `description`/`html_template_path` (Phase 2) -- both are genuinely
useful (category for picker filtering + is_active for soft-disabling
a template without deleting it and orphaning resumes that reference
it; description for user-facing copy + html_template_path for
whatever server-side rendering is introduced in a later phase).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.resume import Resume


class Template(Base):
    """A selectable resume template (e.g. ATS Classic, Modern, Professional, Minimal)."""

    __tablename__ = "templates"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )

    name: Mapped[str] = mapped_column(
        String(100),
        unique=True,
        nullable=False,
        doc='Display name, e.g. "ATS Classic".',
    )

    category: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
        doc='Grouping used for filtering in the template picker, e.g. "professional".',
    )

    description: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        doc="User-facing description shown in the template picker.",
    )

    preview_image: Mapped[str | None] = mapped_column(
        String(500),
        nullable=True,
        doc="URL or storage path to a preview thumbnail image.",
    )

    html_template_path: Mapped[str | None] = mapped_column(
        String(500),
        nullable=True,
        doc="Server-side path/identifier for this template's rendering "
        "definition, for use by a later server-side rendering/PDF phase.",
    )

    is_active: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
        nullable=False,
        doc="Whether this template is currently offered to users.",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    # ---- Relationships ----
    # A template can be used by many resumes. Intentionally NOT
    # cascade-deleted: removing a template must not delete anyone's
    # resumes (see ForeignKey ondelete="SET NULL" on Resume.template_id).
    resumes: Mapped[list["Resume"]] = relationship(
        "Resume",
        back_populates="template",
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<Template id={self.id} name={self.name!r}>"
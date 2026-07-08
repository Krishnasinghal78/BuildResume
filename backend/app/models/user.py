"""
User ORM model.

Represents a registered BuildResume account. Passwords are never
stored in plain text -- `hashed_password` holds a bcrypt hash produced
by the (not-yet-implemented) auth service; this model has no
knowledge of hashing itself.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    # Imported only for static type checking -- avoids a circular
    # import at runtime between user.py and resume.py / user_session.py.
    from app.models.resume import Resume
    from app.models.user_session import UserSession


class User(Base):
    """A registered user account."""

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        doc="Primary key, generated client-side as a UUID4.",
    )

    email: Mapped[str] = mapped_column(
        String(255),
        unique=True,
        index=True,
        nullable=False,
        doc="Unique login email address.",
    )

    username: Mapped[str] = mapped_column(
        String(50),
        unique=True,
        index=True,
        nullable=False,
        doc="Unique public-facing username.",
    )

    hashed_password: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        doc="Bcrypt hash of the user's password. Never the plain-text password.",
    )

    is_active: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
        nullable=False,
        doc="Soft-disable flag; inactive users are denied login.",
    )

    email_verified: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
        doc="Set True only after the signup OTP has been successfully verified. "
        "Unverified users are denied login.",
    )

    last_login_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        doc="Timestamp of the most recent successful (OTP-verified) login.",
    )

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
    # A user can own many resumes. Deleting a user cascades to their
    # resumes at the database level (see ForeignKey ondelete="CASCADE"
    # on Resume.user_id) and at the ORM level via cascade= below, so
    # both raw SQL deletes and ORM-level deletes behave consistently.
    resumes: Mapped[list["Resume"]] = relationship(
        "Resume",
        back_populates="owner",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    # A user can have many active device sessions (rolling refresh-token
    # sessions -- see UserSession). Same cascade behavior as resumes.
    sessions: Mapped[list["UserSession"]] = relationship(
        "UserSession",
        back_populates="user",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<User id={self.id} email={self.email!r} username={self.username!r}>"

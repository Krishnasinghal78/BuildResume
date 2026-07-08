"""
User session ORM model.

Backs the rolling, device-bound refresh-token sessions described in
Phase 1D: each row is one signed-in device. A session's `expires_at`
is pushed forward every time its refresh token is used (see
app/services/session_service.py), which is what makes it "rolling" --
an active user's session effectively never expires, while an
abandoned one dies after REFRESH_TOKEN_EXPIRE_DAYS of no activity.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.user import User


class UserSession(Base):
    """A single device's rolling, refresh-token-backed login session."""

    __tablename__ = "user_sessions"

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
    )

    refresh_token_hash: Mapped[str] = mapped_column(
        String(64),
        unique=True,
        index=True,
        nullable=False,
        doc="SHA-256 hex digest of the opaque refresh token. The raw "
        "token is returned to the client exactly once (at login or "
        "refresh time) and is never itself persisted.",
    )

    device_id: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        index=True,
        doc="Client-supplied (or server-generated, if the client had "
        "none yet) identifier for 'remember this device'. The client "
        "persists this and sends it back on future login/refresh calls.",
    )

    last_activity: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        doc="Updated every time this session's refresh token is used.",
    )

    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        doc="Rolling expiry, pushed forward on every successful refresh. "
        "The session only dies after this many days pass with NO "
        "refresh activity at all -- not a fixed number of days since login.",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    # ---- Relationships ----
    user: Mapped["User"] = relationship(
        "User",
        back_populates="sessions",
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<UserSession id={self.id} user_id={self.user_id} device_id={self.device_id!r}>"
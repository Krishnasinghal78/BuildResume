"""
OTP code ORM model.

Stores a single one-time-password issuance: its hash (never the raw
code), which email it was sent to, what it's for, when it expires,
and whether it's already been consumed. A row here is single-use --
once `is_used` is True it can never be verified again.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Enum, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class OtpPurpose(str, enum.Enum):
    """What an OTP code is being used for."""

    SIGNUP = "signup"
    LOGIN = "login"
    PASSWORD_RESET = "password_reset"  # reserved for a future phase; not issued yet


class OtpCode(Base):
    """A single issued one-time-password code."""

    __tablename__ = "otp_codes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )

    email: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        index=True,
        doc="Email address this OTP was issued for.",
    )

    otp_code_hash: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        doc="SHA-256 hex digest of the 6-digit code. The raw code is "
        "never stored -- only emailed once at issuance time.",
    )

    purpose: Mapped[OtpPurpose] = mapped_column(
        Enum(OtpPurpose, name="otp_purpose", native_enum=True),
        nullable=False,
        doc="What this code authorizes: signup, login, or password_reset.",
    )

    payload: Mapped[dict[str, Any] | None] = mapped_column(
        JSONB,
        nullable=True,
        doc="Pending data needed to complete the flow once verified -- "
        "e.g. {'username': ..., 'hashed_password': ...} for purpose="
        "'signup', where the User row isn't created until the OTP is "
        "confirmed. Null for purposes that don't need it (e.g. 'login').",
    )

    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        doc="OTP is invalid after this instant, even if unused.",
    )

    is_used: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
        doc="Set True the instant this code is successfully verified; "
        "a used code can never be verified again.",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<OtpCode id={self.id} email={self.email!r} purpose={self.purpose.value}>"

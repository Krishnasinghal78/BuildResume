"""
OTP code repository.

Owns all direct database access for the `otp_codes` table. Contains
no business rules (expiry checking, hash verification, etc.) -- that
logic belongs in app/services/otp_service.py. This layer only knows
how to read and write rows.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.otp_code import OtpCode, OtpPurpose


class OtpRepository:
    """Database access for the `otp_codes` table."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def create(
        self,
        email: str,
        otp_code_hash: str,
        purpose: OtpPurpose,
        expires_at: datetime,
        payload: dict[str, Any] | None = None,
    ) -> OtpCode:
        """Persist a new OTP code row."""
        otp = OtpCode(
            email=email,
            otp_code_hash=otp_code_hash,
            purpose=purpose,
            expires_at=expires_at,
            payload=payload,
            is_used=False,
        )
        self.db.add(otp)
        self.db.commit()
        self.db.refresh(otp)
        return otp

    def get_latest_unused(self, email: str, purpose: OtpPurpose) -> OtpCode | None:
        """
        Return the most recently issued, not-yet-used OTP for this
        email + purpose (i.e. the one a verification attempt should be
        checked against), or None if there isn't one.
        """
        stmt = (
            select(OtpCode)
            .where(
                OtpCode.email == email,
                OtpCode.purpose == purpose,
                OtpCode.is_used.is_(False),
            )
            .order_by(OtpCode.created_at.desc())
        )
        return self.db.execute(stmt).scalars().first()

    def mark_used(self, otp: OtpCode) -> OtpCode:
        """Flag an OTP row as consumed so it can never be verified again."""
        otp.is_used = True
        self.db.add(otp)
        self.db.commit()
        self.db.refresh(otp)
        return otp

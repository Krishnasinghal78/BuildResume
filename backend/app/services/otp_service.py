"""
OTP service.

Business logic for issuing and verifying one-time-password codes.
Nothing here talks HTTP; app/api/v1/auth.py is responsible for
translating these exceptions into HTTP responses.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import generate_otp_code, hash_otp_code, verify_otp_code
from app.models.otp_code import OtpPurpose
from app.repositories.otp_repository import OtpRepository
from app.services.email_service import EmailDeliveryError, get_email_service

logger = logging.getLogger("buildresume.otp")


class OtpInvalidError(Exception):
    """Raised when a submitted OTP doesn't match any unused, active code."""


class OtpExpiredError(Exception):
    """Raised when a submitted OTP matches a code that has since expired."""


def _ensure_aware(dt: datetime) -> datetime:
    """Treat naive datetimes coming back from the DB as UTC."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


class OtpService:
    """Issues and verifies OTP codes for signup and login."""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.otp_repository = OtpRepository(db)
        self.email_service = get_email_service()

    def issue_otp(
        self,
        email: str,
        purpose: OtpPurpose,
        payload: dict[str, Any] | None = None,
    ) -> None:
        """
        Generate a fresh OTP, store only its hash, and email the raw
        code. `payload` carries whatever data is needed to complete the
        flow once verified (e.g. pending signup username/hashed_password)
        without creating any real record before verification succeeds.

        Raises:
            EmailDeliveryError: the OTP was generated and stored
                successfully, but the email itself could not be sent
                (SMTP auth failure, network error, etc). The OTP row
                still exists in the database when this happens -- see
                app/services/email_service.py for what "sending"
                means for the currently-configured EMAIL_PROVIDER.
        """
        code = generate_otp_code()
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=settings.OTP_EXPIRE_MINUTES)

        self.otp_repository.create(
            email=email,
            otp_code_hash=hash_otp_code(code),
            purpose=purpose,
            expires_at=expires_at,
            payload=payload,
        )

        try:
            self.email_service.send_otp_email(to_email=email, otp_code=code, purpose=purpose.value)
        except EmailDeliveryError:
            logger.error(
                "OTP was generated and stored for %s (purpose=%s) but email delivery failed.",
                email, purpose.value,
            )
            raise

    def verify_otp(self, email: str, code: str, purpose: OtpPurpose) -> dict[str, Any] | None:
        """
        Verify a submitted OTP and mark it used so it can never be
        replayed. Returns the stored payload (may be None).

        Raises:
            OtpInvalidError: no matching unused OTP for this
                email+purpose, or the submitted code is wrong.
            OtpExpiredError: a matching code was found but its expiry
                has passed.
        """
        otp = self.otp_repository.get_latest_unused(email=email, purpose=purpose)
        if otp is None or not verify_otp_code(code, otp.otp_code_hash):
            raise OtpInvalidError("Incorrect, expired, or already-used OTP code.")

        if datetime.now(timezone.utc) > _ensure_aware(otp.expires_at):
            raise OtpExpiredError("This OTP code has expired. Please request a new one.")

        self.otp_repository.mark_used(otp)
        return otp.payload

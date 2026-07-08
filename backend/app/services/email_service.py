"""
Email sending abstraction.

Only a mock implementation exists for now -- Phase 1D explicitly
defers real SMTP/SendGrid/SES/Resend integration. Every call to
send_otp_email() logs the OTP instead of sending a real email, which
is enough to build and test the OTP flow end-to-end locally.

To use a real provider later: implement EmailService's interface in
a new class (e.g. GmailSmtpEmailService, SendGridEmailService,
SesEmailService, ResendEmailService) and change what
get_email_service() returns below -- nothing in the auth service or
API layer needs to change, since they only ever depend on the
abstract EmailService interface.
"""

import logging
from abc import ABC, abstractmethod

logger = logging.getLogger("buildresume.email")


class EmailService(ABC):
    """Abstract email-sending interface every provider implementation follows."""

    @abstractmethod
    def send_otp_email(self, to_email: str, otp_code: str, purpose: str) -> None:
        """Send a one-time-password code to `to_email` for the given purpose."""
        raise NotImplementedError


class MockEmailService(EmailService):
    """
    Development/test stand-in that logs the OTP instead of emailing it.

    IMPORTANT: never use this in production -- it exists purely so the
    OTP flow can be built and tested end-to-end before a real email
    provider is wired up.
    """

    def send_otp_email(self, to_email: str, otp_code: str, purpose: str) -> None:
        logger.info(
            "[MOCK EMAIL] To: %s | Purpose: %s | OTP Code: %s "
            "(this would be a real email in production)",
            to_email,
            purpose,
            otp_code,
        )


def get_email_service() -> EmailService:
    """
    Returns the active EmailService implementation.

    This is the single place to change when a real provider (Gmail
    SMTP, SendGrid, AWS SES, Resend, ...) is introduced -- e.g.:

        def get_email_service() -> EmailService:
            return SendGridEmailService(api_key=settings.SENDGRID_API_KEY)
    """
    return MockEmailService()

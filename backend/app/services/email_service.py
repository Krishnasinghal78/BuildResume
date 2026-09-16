"""
Email sending abstraction.

Two implementations exist:
  - MockEmailService  -- logs the OTP instead of sending it (dev/test default)
  - GmailSmtpEmailService -- sends real email via Gmail's SMTP servers

Which one is active is controlled entirely by the EMAIL_PROVIDER
environment variable (see app/core/config.py) -- nothing in
OtpService, AuthService, or the API routes needs to change to switch
between them, since they only ever depend on the abstract
EmailService interface via get_email_service().

============================================================
GMAIL SMTP SETUP INSTRUCTIONS
============================================================
Gmail will NOT accept your normal account password over SMTP if
2-Step Verification is enabled (which Google now requires for most
accounts) -- you need a 16-character "App Password" instead:

  1. Go to https://myaccount.google.com/security
  2. Enable "2-Step Verification" if it isn't already on.
  3. Go to https://myaccount.google.com/apppasswords
  4. Create a new App Password (choose "Mail" as the app).
  5. Google shows you a 16-character password ONCE -- copy it.

Then set these in your .env (see .env.example):

  EMAIL_PROVIDER=gmail_smtp
  SMTP_HOST=smtp.gmail.com
  SMTP_PORT=587
  SMTP_USERNAME=your_gmail_address@gmail.com
  SMTP_PASSWORD=the_16_character_app_password   # NOT your login password
  SMTP_FROM_EMAIL=your_gmail_address@gmail.com
  SMTP_FROM_NAME=BuildResume
  SMTP_USE_TLS=True

Gmail's free SMTP has a sending cap (roughly 500 emails/day per
account) -- fine for OTP volumes during development/small-scale
production, but consider SendGrid/SES/Resend if you outgrow it. That
swap only ever requires a new class here + changing get_email_service().

ROLLBACK: if Gmail SMTP ever fails or you need to disable outbound
email temporarily, set EMAIL_PROVIDER=mock and restart the app. OTPs
go back to being logged to the console exactly as before -- no code
change, no redeploy of anything but the env var.
============================================================
"""

import logging
import smtplib
from abc import ABC, abstractmethod
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.core.config import settings

logger = logging.getLogger("buildresume.email")

_PURPOSE_LABELS = {
    "signup": "Verify your email",
    "login": "Your login code",
    "password_reset": "Reset your password",
}


class EmailDeliveryError(Exception):
    """
    Raised when an OTP email genuinely could not be sent (SMTP auth
    failure, network error, invalid recipient, etc). Callers (the API
    layer) are expected to catch this and return a clear, non-crashing
    error to the client rather than a raw 500 traceback.
    """


class EmailService(ABC):
    """Abstract email-sending interface every provider implementation follows."""

    @abstractmethod
    def send_otp_email(self, to_email: str, otp_code: str, purpose: str) -> None:
        """
        Send a one-time-password code to `to_email` for the given purpose.

        Raises:
            EmailDeliveryError: if the email genuinely could not be sent.
        """
        raise NotImplementedError


class MockEmailService(EmailService):
    """
    Development/test stand-in that logs the OTP instead of emailing it.

    IMPORTANT: never use this in production -- it exists purely so the
    OTP flow can be built and tested end-to-end before (or without)
    real email delivery configured. This is also the instant rollback
    target if GmailSmtpEmailService ever needs to be disabled -- see
    the module docstring.
    """

    def send_otp_email(self, to_email: str, otp_code: str, purpose: str) -> None:
        logger.info(
            "[MOCK EMAIL] To: %s | Purpose: %s | OTP Code: %s "
            "(this would be a real email in production)",
            to_email,
            purpose,
            otp_code,
        )


class GmailSmtpEmailService(EmailService):
    """
    Sends real OTP emails via Gmail's SMTP servers.

    Credentials are read from environment variables (see the module
    docstring for the full Gmail App Password setup) -- never
    hardcoded here. Connection details (host/port/TLS) are also
    configurable so the same class works against any standard SMTP
    provider, not just Gmail specifically, if the settings are pointed
    elsewhere.
    """

    def __init__(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
        from_email: str,
        from_name: str,
        use_tls: bool,
    ) -> None:
        if not username or not password or not from_email:
            # Fails fast and clearly at construction time (when
            # get_email_service() is first called) rather than
            # halfway through an SMTP handshake with a confusing
            # authentication error.
            raise EmailDeliveryError(
                "EMAIL_PROVIDER=gmail_smtp is set but SMTP_USERNAME, "
                "SMTP_PASSWORD, or SMTP_FROM_EMAIL is missing from the "
                "environment. See app/services/email_service.py's module "
                "docstring for setup instructions."
            )
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.from_email = from_email
        self.from_name = from_name
        self.use_tls = use_tls

    def send_otp_email(self, to_email: str, otp_code: str, purpose: str) -> None:
        subject = _PURPOSE_LABELS.get(purpose, "Your verification code")
        message = MIMEMultipart("alternative")
        message["Subject"] = f"{subject} - BuildResume"
        message["From"] = f"{self.from_name} <{self.from_email}>"
        message["To"] = to_email

        text_body = (
            f"Your BuildResume verification code is: {otp_code}\n\n"
            f"This code expires in {settings.OTP_EXPIRE_MINUTES} minutes and can only be used once.\n"
            f"If you didn't request this, you can safely ignore this email."
        )
        html_body = f"""
        <html><body style="font-family: Arial, sans-serif; color: #1a1a1a;">
          <p>Your BuildResume verification code is:</p>
          <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px;">{otp_code}</p>
          <p style="color: #555; font-size: 13px;">
            This code expires in {settings.OTP_EXPIRE_MINUTES} minutes and can only be used once.<br>
            If you didn't request this, you can safely ignore this email.
          </p>
        </body></html>
        """
        message.attach(MIMEText(text_body, "plain"))
        message.attach(MIMEText(html_body, "html"))

        try:
            with smtplib.SMTP(self.host, self.port, timeout=10) as server:
                if self.use_tls:
                    server.starttls()
                server.login(self.username, self.password)
                server.sendmail(self.from_email, [to_email], message.as_string())

            logger.info("OTP email sent via Gmail SMTP to %s (purpose=%s)", to_email, purpose)

        except smtplib.SMTPAuthenticationError as exc:
            logger.error("Gmail SMTP authentication failed: %s", exc)
            raise EmailDeliveryError(
                "Email authentication failed. Check SMTP_USERNAME/SMTP_PASSWORD "
                "(must be a Gmail App Password, not your regular password)."
            ) from exc
        except smtplib.SMTPRecipientsRefused as exc:
            logger.error("Gmail SMTP refused recipient %s: %s", to_email, exc)
            raise EmailDeliveryError(f"The email address '{to_email}' was refused by the mail server.") from exc
        except (smtplib.SMTPException, OSError) as exc:
            # OSError covers connection/timeout failures (e.g. no network,
            # SMTP host unreachable) which smtplib surfaces as socket errors.
            logger.error("Failed to send OTP email to %s via Gmail SMTP: %s", to_email, exc)
            raise EmailDeliveryError(
                "Could not send the verification email right now. Please try again shortly."
            ) from exc


def get_email_service() -> EmailService:
    """
    Returns the active EmailService implementation, chosen by the
    EMAIL_PROVIDER environment variable:

        EMAIL_PROVIDER=mock         -> MockEmailService (default)
        EMAIL_PROVIDER=gmail_smtp   -> GmailSmtpEmailService

    This is the single place to change when a different provider
    (SendGrid, AWS SES, Resend, ...) is introduced -- implement its
    own EmailService subclass above and add another branch here.
    """
    provider = settings.EMAIL_PROVIDER.strip().lower()

    if provider == "gmail_smtp":
        return GmailSmtpEmailService(
            host=settings.SMTP_HOST,
            port=settings.SMTP_PORT,
            username=settings.SMTP_USERNAME,
            password=settings.SMTP_PASSWORD,
            from_email=settings.SMTP_FROM_EMAIL,
            from_name=settings.SMTP_FROM_NAME,
            use_tls=settings.SMTP_USE_TLS,
        )

    if provider != "mock":
        logger.warning(
            "Unrecognized EMAIL_PROVIDER=%r -- falling back to MockEmailService. "
            "Valid values are 'mock' or 'gmail_smtp'.",
            settings.EMAIL_PROVIDER,
        )

    return MockEmailService()

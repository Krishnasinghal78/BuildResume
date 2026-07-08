"""
Authentication service.

Owns all business rules around registering, authenticating, and
resolving users -- OTP-gated signup, OTP-gated login, rolling
session issuance, and turning "what went wrong" into meaningful,
specific exceptions. Nothing here talks HTTP; app/api/v1/auth.py and
app/api/deps.py are responsible for translating these exceptions into
HTTP responses.

This class composes OtpService and SessionService rather than routes
calling them directly, so the API layer only ever talks to
AuthService and stays a thin HTTP layer as required.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.core.security import create_access_token, hash_password, verify_password
from app.models.otp_code import OtpPurpose
from app.models.user import User
from app.repositories.user_repository import UserRepository
from app.services.otp_service import OtpExpiredError, OtpInvalidError, OtpService
from app.services.session_service import SessionExpiredError, SessionNotFoundError, SessionService

# Re-exported so route code can catch them via `from app.services.auth_service import ...`
# without also having to import app.services.otp_service / session_service directly.
__all__ = [
    "AuthService",
    "EmailAlreadyRegisteredError",
    "UsernameAlreadyTakenError",
    "InvalidCredentialsError",
    "InactiveUserError",
    "EmailNotVerifiedError",
    "UserNotFoundError",
    "OtpInvalidError",
    "OtpExpiredError",
    "SessionNotFoundError",
    "SessionExpiredError",
]


class EmailAlreadyRegisteredError(Exception):
    """Raised when registering with an email that's already in use by a verified account."""


class UsernameAlreadyTakenError(Exception):
    """Raised when registering with a username that's already in use by a verified account."""


class InvalidCredentialsError(Exception):
    """Raised when login email/password don't match any active user."""


class InactiveUserError(Exception):
    """Raised when authentication succeeds but the account has been disabled."""


class EmailNotVerifiedError(Exception):
    """Raised when login credentials are correct but the account never completed signup OTP verification."""


class UserNotFoundError(Exception):
    """Raised when a user id (e.g. from a JWT) doesn't resolve to a real user."""


class AuthService:
    """Business logic for OTP-gated registration, OTP-gated login, and session/token issuance."""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.user_repository = UserRepository(db)
        self.otp_service = OtpService(db)
        self.session_service = SessionService(db)

    # -----------------------------------------------------------
    # Registration: initiate (send OTP) -> complete (verify OTP, create user)
    # -----------------------------------------------------------

    def initiate_registration(self, email: str, username: str, password: str) -> None:
        """
        Start the signup flow: validate uniqueness, then send a signup
        OTP. No user row is created yet -- the pending username and
        password hash are stashed in the OTP record's payload and only
        become a real account once the OTP is verified.

        Raises:
            EmailAlreadyRegisteredError: `email` already belongs to an account.
            UsernameAlreadyTakenError: `username` already belongs to an account.
        """
        if self.user_repository.get_by_email(email) is not None:
            raise EmailAlreadyRegisteredError(f"Email '{email}' is already registered.")

        if self.user_repository.get_by_username(username) is not None:
            raise UsernameAlreadyTakenError(f"Username '{username}' is already taken.")

        self.otp_service.issue_otp(
            email=email,
            purpose=OtpPurpose.SIGNUP,
            payload={"username": username, "hashed_password": hash_password(password)},
        )

    def complete_registration(self, email: str, otp_code: str) -> User:
        """
        Verify a signup OTP and create the user account from the
        pending payload stashed at `initiate_registration` time.

        Raises:
            OtpInvalidError / OtpExpiredError: bad or expired OTP.
            EmailAlreadyRegisteredError / UsernameAlreadyTakenError: someone
                else registered the same email/username while this OTP
                was outstanding (rare race, checked again defensively).
        """
        payload = self.otp_service.verify_otp(email=email, code=otp_code, purpose=OtpPurpose.SIGNUP)
        payload = payload or {}
        username = payload.get("username")
        hashed_password = payload.get("hashed_password")

        if self.user_repository.get_by_email(email) is not None:
            raise EmailAlreadyRegisteredError(f"Email '{email}' is already registered.")
        if username and self.user_repository.get_by_username(username) is not None:
            raise UsernameAlreadyTakenError(f"Username '{username}' is already taken.")

        user = self.user_repository.create_user(
            email=email,
            username=username,
            hashed_password=hashed_password,
        )
        user.email_verified = True
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    # -----------------------------------------------------------
    # Login: initiate (validate password, send OTP) -> complete (verify OTP, issue tokens)
    # -----------------------------------------------------------

    def initiate_login(self, email: str, password: str) -> None:
        """
        Validate email + password and, if correct, send a login OTP.
        No tokens are issued at this stage.

        Raises:
            InvalidCredentialsError: no active user matches, or the
                password is wrong. Deliberately the same error for
                both cases, so a caller can't use response differences
                to enumerate which emails are registered.
            InactiveUserError: the account has been disabled.
            EmailNotVerifiedError: the account never completed signup
                OTP verification.
        """
        user = self.user_repository.get_by_email(email)
        if user is None or not verify_password(password, user.hashed_password):
            raise InvalidCredentialsError("Incorrect email or password.")

        if not user.is_active:
            raise InactiveUserError("This account has been disabled.")

        if not user.email_verified:
            raise EmailNotVerifiedError("This account has not completed email verification.")

        self.otp_service.issue_otp(email=email, purpose=OtpPurpose.LOGIN)

    def complete_login(
        self,
        email: str,
        otp_code: str,
        device_id: str | None,
    ) -> tuple[User, str, str, str]:
        """
        Verify a login OTP, update `last_login_at`, and issue a fresh
        access token + rolling refresh-token session.

        Returns (user, access_token, refresh_token, device_id).

        Raises:
            OtpInvalidError / OtpExpiredError: bad or expired OTP.
            UserNotFoundError: the user was deleted between
                `initiate_login` and this call (rare race).
        """
        self.otp_service.verify_otp(email=email, code=otp_code, purpose=OtpPurpose.LOGIN)

        user = self.user_repository.get_by_email(email)
        if user is None:
            raise UserNotFoundError(f"No user found for email {email!r}.")

        user.last_login_at = datetime.now(timezone.utc)
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)

        access_token = self.create_access_token_for_user(user)
        raw_refresh_token, _session, resolved_device_id = self.session_service.create_session(
            user=user, device_id=device_id
        )
        return user, access_token, raw_refresh_token, resolved_device_id

    # -----------------------------------------------------------
    # Tokens / sessions
    # -----------------------------------------------------------

    def create_access_token_for_user(self, user: User) -> str:
        """Issue a JWT access token whose subject (`sub`) is the user's id."""
        return create_access_token(data={"sub": str(user.id)})

    def refresh_tokens(self, raw_refresh_token: str) -> tuple[str, str]:
        """
        Exchange a still-valid refresh token for a new access token +
        a new (rotated) refresh token, rolling the session forward.

        Raises:
            SessionNotFoundError / SessionExpiredError: see SessionService.
            UserNotFoundError: the session's user no longer exists (rare race).
        """
        new_raw_refresh_token, session = self.session_service.refresh_session(raw_refresh_token)

        user = self.user_repository.get_by_id(session.user_id)
        if user is None:
            raise UserNotFoundError(f"No user found for id {session.user_id!r}.")

        access_token = self.create_access_token_for_user(user)
        return access_token, new_raw_refresh_token

    def logout(self, raw_refresh_token: str) -> None:
        """Revoke a single device session."""
        self.session_service.revoke_session(raw_refresh_token)

    # -----------------------------------------------------------
    # Current user (from a decoded access token's `sub` claim)
    # -----------------------------------------------------------

    def get_current_user(self, user_id: str) -> User:
        """
        Resolve a user id (typically the `sub` claim of a decoded JWT)
        to a real, active User.

        Raises:
            UserNotFoundError: if the id doesn't match any user.
            InactiveUserError: if the user exists but is disabled.
        """
        try:
            parsed_id = uuid.UUID(user_id)
        except (ValueError, AttributeError, TypeError) as exc:
            raise UserNotFoundError(f"Invalid user id: {user_id!r}") from exc

        user = self.user_repository.get_by_id(parsed_id)
        if user is None:
            raise UserNotFoundError(f"No user found for id {user_id!r}.")

        if not user.is_active:
            raise InactiveUserError("This account has been disabled.")

        return user
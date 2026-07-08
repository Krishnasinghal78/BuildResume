"""
Session service.

Business logic for rolling, device-bound refresh-token sessions --
the "stay signed in like Gmail/LinkedIn/GitHub" behavior: a session's
expiry is pushed forward every time it's used, so an active user's
session effectively never expires, while an abandoned one dies after
`REFRESH_TOKEN_EXPIRE_DAYS` days of no activity at all. Nothing here
talks HTTP; app/api/v1/auth.py translates these exceptions into HTTP
responses.
"""

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import generate_refresh_token, hash_refresh_token
from app.models.user import User
from app.models.user_session import UserSession
from app.repositories.session_repository import SessionRepository


class SessionNotFoundError(Exception):
    """Raised when a refresh token doesn't match any known, live session."""


class SessionExpiredError(Exception):
    """Raised when a session's rolling inactivity window has elapsed."""


def _ensure_aware(dt: datetime) -> datetime:
    """Treat naive datetimes coming back from the DB as UTC."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


class SessionService:
    """Creates, refreshes, and revokes rolling device sessions."""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.session_repository = SessionRepository(db)

    def _rolling_expiry(self) -> datetime:
        return datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)

    def create_session(self, user: User, device_id: str | None) -> tuple[str, UserSession, str]:
        """
        Start a new rolling session for `user`.

        `device_id` should be whatever the client already has stored
        for "remember this device"; if the client has none yet (first
        login on this device), one is generated here and returned so
        the client can persist it for next time.

        Returns (raw_refresh_token, session, device_id). The raw token
        is returned ONLY here and on refresh -- only its hash is ever
        stored in the database.
        """
        resolved_device_id = device_id or str(uuid.uuid4())
        raw_token = generate_refresh_token()

        session = self.session_repository.create(
            user_id=user.id,
            refresh_token_hash=hash_refresh_token(raw_token),
            device_id=resolved_device_id,
            expires_at=self._rolling_expiry(),
        )
        return raw_token, session, resolved_device_id

    def refresh_session(self, raw_refresh_token: str) -> tuple[str, UserSession]:
        """
        Validate a refresh token and roll its session forward.

        On success the refresh token is ROTATED -- a new one is issued
        and the old hash is discarded -- so a refresh token can never
        be used more than once, which is what stops a stolen-but-not-
        yet-used-again token from being replayed indefinitely. The
        session's expiry is pushed `REFRESH_TOKEN_EXPIRE_DAYS` days
        into the future from *now*, which is what makes the session
        "rolling" rather than a hard expiry from login time.

        Raises:
            SessionNotFoundError: token doesn't match any session
                (already rotated away, revoked, or never existed).
            SessionExpiredError: the session's rolling window elapsed
                (the session row is deleted as part of raising this).
        """
        token_hash = hash_refresh_token(raw_refresh_token)
        session = self.session_repository.get_by_refresh_token_hash(token_hash)
        if session is None:
            raise SessionNotFoundError("Refresh token is invalid or has already been used.")

        if datetime.now(timezone.utc) > _ensure_aware(session.expires_at):
            self.session_repository.delete(session)
            raise SessionExpiredError("Session has expired due to inactivity. Please log in again.")

        new_raw_token = generate_refresh_token()
        updated_session = self.session_repository.update_rolling_window(
            session=session,
            new_refresh_token_hash=hash_refresh_token(new_raw_token),
            new_expires_at=self._rolling_expiry(),
            new_last_activity=datetime.now(timezone.utc),
        )
        return new_raw_token, updated_session

    def revoke_session(self, raw_refresh_token: str) -> None:
        """Log out: delete the session matching this refresh token, if any exists."""
        token_hash = hash_refresh_token(raw_refresh_token)
        session = self.session_repository.get_by_refresh_token_hash(token_hash)
        if session is not None:
            self.session_repository.delete(session)

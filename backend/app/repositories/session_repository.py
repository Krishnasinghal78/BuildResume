"""
User session repository.

Owns all direct database access for the `user_sessions` table.
Contains no business rules (rolling-expiry logic, token rotation,
etc.) -- that logic belongs in app/services/session_service.py. This
layer only knows how to read and write rows.
"""

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.user_session import UserSession


class SessionRepository:
    """Database access for the `user_sessions` table."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def create(
        self,
        user_id: uuid.UUID,
        refresh_token_hash: str,
        device_id: str,
        expires_at: datetime,
    ) -> UserSession:
        """Persist a new session row."""
        session = UserSession(
            user_id=user_id,
            refresh_token_hash=refresh_token_hash,
            device_id=device_id,
            expires_at=expires_at,
        )
        self.db.add(session)
        self.db.commit()
        self.db.refresh(session)
        return session

    def get_by_refresh_token_hash(self, refresh_token_hash: str) -> UserSession | None:
        """Return the session matching this refresh token's hash, or None."""
        stmt = select(UserSession).where(UserSession.refresh_token_hash == refresh_token_hash)
        return self.db.execute(stmt).scalar_one_or_none()

    def update_rolling_window(
        self,
        session: UserSession,
        new_refresh_token_hash: str,
        new_expires_at: datetime,
        new_last_activity: datetime,
    ) -> UserSession:
        """Rotate the refresh token hash and push the rolling expiry/activity forward."""
        session.refresh_token_hash = new_refresh_token_hash
        session.expires_at = new_expires_at
        session.last_activity = new_last_activity
        self.db.add(session)
        self.db.commit()
        self.db.refresh(session)
        return session

    def delete(self, session: UserSession) -> None:
        """Remove a session row (logout, or an expired session being cleaned up)."""
        self.db.delete(session)
        self.db.commit()

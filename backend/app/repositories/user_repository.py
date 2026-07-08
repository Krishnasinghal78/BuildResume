"""
User repository.

Owns all direct database access for the User model. Contains no
business rules (uniqueness checks, password hashing, etc.) -- that
logic belongs in app/services/auth_service.py. This layer only knows
how to read and write rows.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.user import User


class UserRepository:
    """Database access for the `users` table."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_email(self, email: str) -> User | None:
        """Return the user with this email, or None if no such user exists."""
        stmt = select(User).where(User.email == email)
        return self.db.execute(stmt).scalar_one_or_none()

    def get_by_username(self, username: str) -> User | None:
        """Return the user with this username, or None if no such user exists."""
        stmt = select(User).where(User.username == username)
        return self.db.execute(stmt).scalar_one_or_none()

    def get_by_id(self, user_id: uuid.UUID) -> User | None:
        """Return the user with this id, or None if no such user exists."""
        stmt = select(User).where(User.id == user_id)
        return self.db.execute(stmt).scalar_one_or_none()

    def create_user(self, email: str, username: str, hashed_password: str) -> User:
        """
        Persist a new user row.

        `hashed_password` must already be a bcrypt hash -- this method
        performs no hashing itself, only storage. Uniqueness of
        `email`/`username` is the caller's (service layer's)
        responsibility to check before calling this.
        """
        user = User(email=email, username=username, hashed_password=hashed_password)
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user
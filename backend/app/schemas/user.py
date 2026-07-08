"""
Pydantic schemas for User read/create/update payloads.

`hashed_password` is intentionally never exposed here -- it exists
only on the ORM model (app/models/user.py) and is handled exclusively
by the (not-yet-implemented) auth service.
"""

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class UserBase(BaseModel):
    """Fields shared by every user-facing schema."""

    email: EmailStr
    username: str = Field(min_length=3, max_length=50, description="Unique public-facing username.")


class UserCreate(UserBase):
    """Payload for registering a new user (POST /auth/register)."""

    password: str = Field(
        min_length=8,
        max_length=128,
        description="Plain-text password supplied at registration; hashed before storage.",
    )


class UserUpdate(BaseModel):
    """
    Payload for partially updating a user.

    All fields are optional so a client can send only what changed.
    If `password` is provided, the service layer is responsible for
    re-hashing it -- this schema only carries the plain-text value in
    transit from the client to that service.
    """

    email: Optional[EmailStr] = None
    username: Optional[str] = Field(default=None, min_length=3, max_length=50)
    password: Optional[str] = Field(default=None, min_length=8, max_length=128)
    is_active: Optional[bool] = None


class UserRead(UserBase):
    """Public representation of a user, safe to return from the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    is_active: bool
    created_at: datetime
    updated_at: datetime
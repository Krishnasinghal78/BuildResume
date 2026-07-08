"""
Security utilities: password hashing, JWT access tokens, OTP hashing,
and opaque refresh tokens.

This module has no knowledge of the database or HTTP layer -- it is
pure, reusable logic that the service layer (app/services/*) and the
dependency layer (app/api/deps.py) both build on top of.
"""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings

# A single, shared CryptContext for the whole app. "bcrypt" is the
# only scheme configured (no legacy schemes to fall back to), and
# deprecated="auto" means passlib will happily verify against it and
# flag for rehash if we ever add a stronger scheme in front of it later.
_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    """Hash a plain-text password for storage. Never store the raw password."""
    return _pwd_context.hash(password)


def verify_password(password: str, hashed_password: str) -> bool:
    """Check a plain-text password against a stored bcrypt hash."""
    return _pwd_context.verify(password, hashed_password)


def create_access_token(data: dict[str, Any], expires_delta: timedelta | None = None) -> str:
    """
    Create a signed, short-lived JWT access token.

    `data` is typically `{"sub": <user_id as str>}`. A `"type": "access"`
    claim is always added so deps.py can reject any token that isn't
    specifically an access token, even though refresh tokens in this
    system are opaque (not JWTs) and so could never be confused with
    one anyway -- the claim is cheap, explicit defense-in-depth.
    """
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire, "type": "access"})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_access_token(token: str) -> dict[str, Any]:
    """
    Decode and verify a JWT access token.

    Raises `jose.JWTError` (or a subclass, e.g. `ExpiredSignatureError`)
    if the token is invalid, malformed, or expired. Callers (deps.py)
    are responsible for turning that into an HTTP 401.
    """
    return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])


# ---------------------------------------------------------------
# OTP hashing
# OTPs are short-lived, single-use, 6-digit codes -- bcrypt is
# unnecessary (and slow) for these; a plain SHA-256 digest is
# sufficient since the real protections are expiry + one-time-use,
# not hash cost. The raw code is never stored, only its digest.
# ---------------------------------------------------------------

def generate_otp_code() -> str:
    """Generate a cryptographically random 6-digit OTP, e.g. "042317"."""
    return f"{secrets.randbelow(1_000_000):06d}"


def hash_otp_code(code: str) -> str:
    """SHA-256 hex digest of an OTP code, for storage/comparison."""
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def verify_otp_code(code: str, code_hash: str) -> bool:
    """Constant-time comparison of a submitted OTP against its stored hash."""
    return secrets.compare_digest(hash_otp_code(code), code_hash)


# ---------------------------------------------------------------
# Opaque refresh tokens
# Deliberately NOT JWTs: a refresh token needs to be revocable and
# individually trackable per device/session (see UserSession), which
# a stateless JWT can't do without an extra denylist mechanism anyway.
# A random opaque token whose hash is checked against the database
# gives revocability and rolling-expiry tracking for free.
# ---------------------------------------------------------------

def generate_refresh_token() -> str:
    """Generate a cryptographically random opaque refresh token."""
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    """SHA-256 hex digest of a refresh token, for storage/comparison."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


__all__ = [
    "hash_password",
    "verify_password",
    "create_access_token",
    "decode_access_token",
    "generate_otp_code",
    "hash_otp_code",
    "verify_otp_code",
    "generate_refresh_token",
    "hash_refresh_token",
    "JWTError",
]
"""
Pydantic schemas for authentication requests/responses.

These carry no ORM-facing logic -- they exist purely to define the
request/response shape of the auth endpoints. Field-level validation
(e.g. exactly 6 digits for an OTP) lives here so bad input is
rejected before it ever reaches the service layer.
"""

from typing import Optional

from pydantic import BaseModel, EmailStr, Field


class MessageResponse(BaseModel):
    """Generic confirmation response used by steps that don't return tokens."""

    message: str


class LoginRequest(BaseModel):
    """Payload for POST /auth/login (step 1: validate credentials, triggers an OTP email)."""

    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class OtpVerifyRequest(BaseModel):
    """Payload for POST /auth/register/verify-otp (completes signup)."""

    email: EmailStr
    otp_code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$", description="6-digit numeric OTP.")


class LoginOtpVerifyRequest(BaseModel):
    """Payload for POST /auth/login/verify-otp (completes login, issues tokens)."""

    email: EmailStr
    otp_code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$", description="6-digit numeric OTP.")
    device_id: Optional[str] = Field(
        default=None,
        max_length=255,
        description="Client-persisted device identifier for 'remember this device'. "
        "Omit on first login from a new device -- the server will generate one and "
        "return it for the client to store.",
    )


class RefreshRequest(BaseModel):
    """Payload for POST /auth/refresh."""

    refresh_token: str = Field(min_length=1, description="The refresh token issued at login or by a previous refresh.")


class LogoutRequest(BaseModel):
    """Payload for POST /auth/logout."""

    refresh_token: str = Field(min_length=1)


class TokenResponse(BaseModel):
    """Response returned after a successful login OTP verification or token refresh."""

    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    device_id: Optional[str] = Field(
        default=None,
        description="Present on login only. Persist this and send it back as "
        "device_id on future logins from the same device.",
    )

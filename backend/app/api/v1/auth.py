"""
Authentication API routes.

Thin HTTP layer: parses/validates requests via Pydantic schemas,
delegates all real work to AuthService, and translates service-layer
exceptions into the appropriate HTTP status codes. No business logic
lives here.

Flow implemented (Phase 1D):
    POST /auth/register             -> validate + send signup OTP
    POST /auth/register/verify-otp  -> verify OTP + create the user
    POST /auth/login                -> validate credentials + send login OTP
    POST /auth/login/verify-otp     -> verify OTP + issue access/refresh tokens
    POST /auth/refresh              -> exchange refresh token for a new pair
    POST /auth/logout               -> revoke a single device session
    GET  /auth/me                   -> current authenticated user (access token)
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.schemas.auth import (
    LoginOtpVerifyRequest,
    LoginRequest,
    LogoutRequest,
    MessageResponse,
    OtpVerifyRequest,
    RefreshRequest,
    TokenResponse,
)
from app.schemas.user import UserCreate, UserRead
from app.services.auth_service import (
    AuthService,
    EmailAlreadyRegisteredError,
    EmailNotVerifiedError,
    InactiveUserError,
    InvalidCredentialsError,
    OtpExpiredError,
    OtpInvalidError,
    SessionExpiredError,
    SessionNotFoundError,
    UsernameAlreadyTakenError,
    UserNotFoundError,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post(
    "/register",
    response_model=MessageResponse,
    status_code=status.HTTP_200_OK,
    summary="Step 1: start registration and send a signup OTP",
)
def register(payload: UserCreate, db: Session = Depends(get_db)) -> MessageResponse:
    """
    Validate that the email/username are available, then email a
    6-digit OTP. No account is created yet -- call
    POST /auth/register/verify-otp with that code to finish.
    """
    auth_service = AuthService(db)
    try:
        auth_service.initiate_registration(
            email=payload.email,
            username=payload.username,
            password=payload.password,
        )
    except EmailAlreadyRegisteredError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except UsernameAlreadyTakenError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    return MessageResponse(message="OTP sent to your email. Verify it to complete registration.")


@router.post(
    "/register/verify-otp",
    response_model=MessageResponse,
    summary="Step 2: verify the signup OTP and create the account",
)
def verify_registration_otp(payload: OtpVerifyRequest, db: Session = Depends(get_db)) -> MessageResponse:
    """Complete registration: verifying the OTP creates the user account."""
    auth_service = AuthService(db)
    try:
        auth_service.complete_registration(email=payload.email, otp_code=payload.otp_code)
    except OtpExpiredError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except OtpInvalidError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except EmailAlreadyRegisteredError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except UsernameAlreadyTakenError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    return MessageResponse(message="User registered successfully")


@router.post(
    "/login",
    response_model=MessageResponse,
    summary="Step 1: validate credentials and send a login OTP",
)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> MessageResponse:
    """
    Validate email + password. No tokens are issued yet -- call
    POST /auth/login/verify-otp with the emailed code to finish.
    """
    auth_service = AuthService(db)
    try:
        auth_service.initiate_login(email=payload.email, password=payload.password)
    except InvalidCredentialsError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    except InactiveUserError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except EmailNotVerifiedError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc

    return MessageResponse(message="OTP sent to your email. Verify it to continue.")


@router.post(
    "/login/verify-otp",
    response_model=TokenResponse,
    summary="Step 2: verify the login OTP and receive access + refresh tokens",
)
def verify_login_otp(payload: LoginOtpVerifyRequest, db: Session = Depends(get_db)) -> TokenResponse:
    """Complete login: verifying the OTP issues a fresh access token and a rolling-session refresh token."""
    auth_service = AuthService(db)
    try:
        _user, access_token, refresh_token, device_id = auth_service.complete_login(
            email=payload.email,
            otp_code=payload.otp_code,
            device_id=payload.device_id,
        )
    except OtpExpiredError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except OtpInvalidError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UserNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    return TokenResponse(access_token=access_token, refresh_token=refresh_token, device_id=device_id)


@router.post(
    "/refresh",
    response_model=TokenResponse,
    summary="Exchange a refresh token for a new access + refresh token pair",
)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)) -> TokenResponse:
    """
    Rolling session refresh: if the refresh token is still valid, its
    session's expiry is pushed forward and a brand-new token pair is
    issued. The old refresh token is invalidated immediately (rotation).
    """
    auth_service = AuthService(db)
    try:
        access_token, new_refresh_token = auth_service.refresh_tokens(payload.refresh_token)
    except SessionNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    except UserNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    # device_id isn't re-issued on refresh (the session row already has
    # it persisted); the client already knows it from the login response.
    return TokenResponse(access_token=access_token, refresh_token=new_refresh_token, device_id=None)


@router.post(
    "/logout",
    response_model=MessageResponse,
    summary="Revoke a single device session",
)
def logout(payload: LogoutRequest, db: Session = Depends(get_db)) -> MessageResponse:
    """Log out this device: deletes the session tied to the given refresh token."""
    auth_service = AuthService(db)
    auth_service.logout(payload.refresh_token)
    return MessageResponse(message="Logged out successfully")


@router.get(
    "/me",
    response_model=UserRead,
    summary="Get the current authenticated user",
)
def read_current_user(current_user: User = Depends(get_current_user)) -> User:
    """Protected endpoint — requires a valid bearer access token. Returns the caller's own profile."""
    return current_user

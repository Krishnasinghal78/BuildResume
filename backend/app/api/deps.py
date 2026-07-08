"""
Shared FastAPI dependencies.

`get_current_user` is the single place that turns a bearer token into
an authenticated `User`, or raises the appropriate HTTP error. Every
protected route depends on this rather than re-implementing token
decoding itself.
"""

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.session import get_db
from app.models.user import User
from app.services.auth_service import AuthService, InactiveUserError, UserNotFoundError

# tokenUrl points Swagger UI's "Authorize" button at the login route;
# it does not perform routing itself, only documents where to send
# username/password to obtain a token.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_V1_PREFIX}/auth/login")


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """
    Resolve the current authenticated user from a bearer JWT.

    Raises:
        HTTPException 401: if the token is missing, malformed, expired,
            or doesn't resolve to an active user.
    """
    credentials_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials.",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = decode_access_token(token)
    except JWTError as exc:
        raise credentials_error from exc

    if payload.get("type") != "access":
        raise credentials_error

    user_id = payload.get("sub")
    if user_id is None:
        raise credentials_error

    auth_service = AuthService(db)
    try:
        return auth_service.get_current_user(user_id)
    except (UserNotFoundError, InactiveUserError) as exc:
        raise credentials_error from exc

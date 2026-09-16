"""
Application configuration.

Centralizes all environment-driven settings behind a single, typed
`Settings` object so the rest of the codebase never reads `os.environ`
directly. Values are loaded from a `.env` file (see `.env.example`)
and/or real environment variables, with environment variables always
taking precedence over `.env` file contents.
"""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Typed application settings.

    Every field has either a sensible development default or is
    required (no default) when it must never be silently guessed in
    production, such as SECRET_KEY and DATABASE_URL.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # ---- General ----
    PROJECT_NAME: str = "BuildResume API"
    ENVIRONMENT: str = "development"
    API_V1_PREFIX: str = "/api/v1"

    # ---- Database ----
    DATABASE_URL: str = Field(
        ...,
        description="SQLAlchemy database URL, e.g. "
        "postgresql+psycopg2://user:password@host:5432/dbname",
    )

    # ---- Security / JWT ----
    SECRET_KEY: str = Field(
        ...,
        min_length=32,
        description="Secret key used to sign JWT access tokens. "
        "Must be a long, random value in production.",
    )
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # ---- OTP (email verification / login OTP) ----
    OTP_EXPIRE_MINUTES: int = 10

    # ---- Email delivery ----
    # "mock" (default) logs the OTP to the console instead of sending a
    # real email -- exactly today's behavior, and the fastest possible
    # rollback if SMTP ever misbehaves in production: set this back to
    # "mock" and restart, no code change required.
    # "gmail_smtp" sends real email via Gmail's SMTP servers using the
    # settings below.
    EMAIL_PROVIDER: str = "mock"

    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM_EMAIL: str = ""
    SMTP_FROM_NAME: str = "BuildResume"
    SMTP_USE_TLS: bool = True

    # ---- CORS ----
    # Kept as a raw string (not List[str]) because pydantic-settings
    # attempts to JSON-decode any List-typed field read from a .env
    # file BEFORE custom validators run, which breaks on a plain
    # comma-separated value like "http://a.com,http://b.com". Parsing
    # is done explicitly in the `BACKEND_CORS_ORIGINS` property below.
    BACKEND_CORS_ORIGINS_RAW: str = Field(default="", alias="BACKEND_CORS_ORIGINS")

    @property
    def BACKEND_CORS_ORIGINS(self) -> list[str]:
        if not self.BACKEND_CORS_ORIGINS_RAW.strip():
            return []
        return [origin.strip() for origin in self.BACKEND_CORS_ORIGINS_RAW.split(",") if origin.strip()]

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() in {"production", "prod"}


@lru_cache
def get_settings() -> Settings:
    """
    Returns a cached Settings instance.

    Using lru_cache means the .env file / environment is only parsed
    once per process, and every part of the app that calls
    get_settings() shares the exact same Settings object.
    """
    return Settings()


settings = get_settings()

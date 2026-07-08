"""
FastAPI application entry point.

Run locally with:
    uvicorn app.main:app --reload

This module is intentionally thin: it wires together settings, CORS,
logging, and the versioned API router. Business logic lives in
`app/services/`, request/response handling in `app/api/`, and nothing
of substance should ever be added directly to this file.
"""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings

# ---------------------------------------------------------------
# Logging
# A dedicated app/core/logging_config.py lands in a later phase.
# For now, a minimal but sane baseline config so log output is
# usable in both local development and container/production logs.
# ---------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO if settings.is_production else logging.DEBUG,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("buildresume")

app = FastAPI(
    title=settings.PROJECT_NAME,
    version="0.1.0",
    description="Backend API for BuildResume — an AI-powered resume builder.",
    # Hide interactive docs in production; keep them available in dev/staging.
    docs_url="/docs" if not settings.is_production else None,
    redoc_url="/redoc" if not settings.is_production else None,
    openapi_url=f"{settings.API_V1_PREFIX}/openapi.json",
)

# ---------------------------------------------------------------
# CORS
# Origins are configured via BACKEND_CORS_ORIGINS in the environment
# so the frontend's allowed origins never need a code change/redeploy.
# ---------------------------------------------------------------
if settings.BACKEND_CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.BACKEND_CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    logger.warning(
        "BACKEND_CORS_ORIGINS is empty — no cross-origin requests will be "
        "allowed. Set it in your .env file if the frontend runs on a "
        "different origin than this API."
    )

# ---------------------------------------------------------------
# Versioned API router
# app/api/v1/router.py is introduced in a later phase (it aggregates
# auth, resumes, templates, ai_assistant, and pdf_export routers).
# Imported defensively here so this app is runnable and testable at
# every phase of the build, not just once every route exists.
# ---------------------------------------------------------------
try:
    from app.api.v1.router import api_router

    app.include_router(api_router, prefix=settings.API_V1_PREFIX)
except ModuleNotFoundError:
    logger.warning(
        "app.api.v1.router not found yet — running with no API routes "
        "mounted. This is expected before that module is added."
    )


@app.get("/", tags=["health"])
def root() -> dict:
    """Unversioned root endpoint — simple liveness check for load balancers."""
    return {"service": settings.PROJECT_NAME, "status": "ok"}


@app.get(f"{settings.API_V1_PREFIX}/health", tags=["health"])
def health_check() -> dict:
    """Versioned health check endpoint."""
    return {"status": "ok", "environment": settings.ENVIRONMENT}


@app.on_event("startup")
def on_startup() -> None:
    logger.info(
        "%s starting up | environment=%s | docs=%s",
        settings.PROJECT_NAME,
        settings.ENVIRONMENT,
        app.docs_url,
    )

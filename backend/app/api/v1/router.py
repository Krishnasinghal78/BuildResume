"""
Central v1 API router.

Aggregates every versioned sub-router into a single `api_router` that
app/main.py mounts under settings.API_V1_PREFIX. This file is the one
place that needs to change to wire a new router in.
"""

from fastapi import APIRouter

from app.api.v1 import auth, resumes, templates

api_router = APIRouter()

api_router.include_router(auth.router)
api_router.include_router(resumes.router)
api_router.include_router(templates.router)

"""
Template API routes.

Thin HTTP layer over TemplateService. Unlike resumes, templates are
public reference data -- these two endpoints are intentionally NOT
behind get_current_user, since any visitor (including one browsing
templates before signing up) should be able to see what's on offer.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas.template import TemplateRead
from app.services.template_service import TemplateNotFoundError, TemplateService

router = APIRouter(prefix="/templates", tags=["templates"])


@router.get(
    "",
    response_model=list[TemplateRead],
    summary="List all active templates",
)
def list_templates(db: Session = Depends(get_db)) -> list[TemplateRead]:
    """Return every currently-active resume template."""
    template_service = TemplateService(db)
    return template_service.list_templates()


@router.get(
    "/{template_id}",
    response_model=TemplateRead,
    summary="Get a single template",
)
def get_template(template_id: uuid.UUID, db: Session = Depends(get_db)) -> TemplateRead:
    """Return a single active template."""
    template_service = TemplateService(db)
    try:
        return template_service.get_template(template_id)
    except TemplateNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

"""
Resume API routes.

Thin HTTP layer: parses/validates requests via Pydantic schemas,
delegates all real work to ResumeService, and translates
service-layer exceptions into the appropriate HTTP status codes. No
business logic lives here. Every route requires a valid access token
(see app.api.deps.get_current_user) -- resumes are always scoped to
the authenticated user.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.schemas.pdf import PDFExportErrorResponse
from app.schemas.resume import ResumeCreate, ResumeRead, ResumeUpdate
from app.services.pdf_service import PDFExportService, PDFGenerationError
from app.services.resume_service import ResumeAccessDeniedError, ResumeNotFoundError, ResumeService
from app.services.template_service import TemplateNotFoundError

router = APIRouter(prefix="/resumes", tags=["resumes"])


@router.post(
    "",
    response_model=ResumeRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new resume",
)
def create_resume(
    payload: ResumeCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ResumeRead:
    """Create a new resume owned by the authenticated user."""
    resume_service = ResumeService(db)
    resume = resume_service.create_resume(user=current_user, payload=payload)
    return resume


@router.get(
    "",
    response_model=list[ResumeRead],
    summary="List the current user's resumes",
)
def list_resumes(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ResumeRead]:
    """Return every resume owned by the authenticated user."""
    resume_service = ResumeService(db)
    return resume_service.get_user_resumes(user=current_user)


@router.get(
    "/{resume_id}",
    response_model=ResumeRead,
    summary="Get a single resume",
)
def get_resume(
    resume_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ResumeRead:
    """Return a single resume, if the authenticated user owns it."""
    resume_service = ResumeService(db)
    try:
        return resume_service.get_resume(resume_id=resume_id, user=current_user)
    except ResumeNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ResumeAccessDeniedError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc


@router.put(
    "/{resume_id}",
    response_model=ResumeRead,
    summary="Update a resume",
)
def update_resume(
    resume_id: uuid.UUID,
    payload: ResumeUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ResumeRead:
    """Update a resume, if the authenticated user owns it. Only fields present in the payload are changed."""
    resume_service = ResumeService(db)
    try:
        return resume_service.update_resume(resume_id=resume_id, user=current_user, payload=payload)
    except ResumeNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ResumeAccessDeniedError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc


@router.delete(
    "/{resume_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a resume",
)
def delete_resume(
    resume_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    """Delete a resume, if the authenticated user owns it."""
    resume_service = ResumeService(db)
    try:
        resume_service.delete_resume(resume_id=resume_id, user=current_user)
    except ResumeNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ResumeAccessDeniedError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc


@router.post(
    "/{resume_id}/export/pdf",
    summary="Export a resume as a downloadable PDF",
    responses={
        200: {"content": {"application/pdf": {}}, "description": "The generated PDF file."},
        403: {"model": PDFExportErrorResponse, "description": "You do not own this resume."},
        404: {"model": PDFExportErrorResponse, "description": "Resume or template not found."},
        500: {"model": PDFExportErrorResponse, "description": "PDF generation failed."},
    },
)
def export_resume_pdf(
    resume_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """
    Render the resume's content + formatting through its selected
    template and return it as a downloadable PDF. Generated entirely
    in memory -- nothing is written to disk or stored in the database.
    """
    pdf_service = PDFExportService(db)
    try:
        pdf_bytes, filename = pdf_service.export_resume_as_pdf(resume_id=resume_id, user=current_user)
    except ResumeNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ResumeAccessDeniedError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except TemplateNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except PDFGenerationError as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

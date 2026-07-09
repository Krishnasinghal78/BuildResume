"""
Resume service.

Owns all business rules around creating, reading, updating, and
deleting resumes -- most importantly, that only a resume's owner may
ever read, update, or delete it. Nothing here talks HTTP;
app/api/v1/resumes.py is responsible for translating these exceptions
into HTTP responses.
"""

import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.models.resume import Resume
from app.models.user import User
from app.repositories.resume_repository import ResumeRepository
from app.schemas.resume import ResumeCreate, ResumeUpdate


class ResumeNotFoundError(Exception):
    """Raised when a resume id doesn't match any resume in the database."""


class ResumeAccessDeniedError(Exception):
    """Raised when a user who doesn't own a resume tries to read/update/delete it."""


class ResumeService:
    """Business logic for resume CRUD, including ownership enforcement."""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.resume_repository = ResumeRepository(db)

    # -----------------------------------------------------------
    # Denormalization
    # -----------------------------------------------------------

    @staticmethod
    def _extract_denormalized_fields(resume_data: dict[str, Any]) -> dict[str, Any]:
        """
        Pull specific, commonly-queried sub-fields out of the
        frontend's `resume_data` blob into flat columns, so simple SQL
        queries (filter/search by name, email, etc.) don't need a
        JSONB containment query against the whole blob.

        Deliberately defensive: `resume_data` is client-supplied and
        not strictly schema-validated (see schemas/resume.py), so every
        lookup here tolerates missing keys/sections rather than
        raising -- a resume that's still being filled in shouldn't
        fail to save just because, say, personalInfo isn't there yet.
        """
        personal_info = resume_data.get("personalInfo") or {}
        summary_section = resume_data.get("summary") or {}

        location_parts = [
            personal_info.get("city"),
            personal_info.get("state"),
            personal_info.get("country"),
        ]
        location = ", ".join(part for part in location_parts if part) or personal_info.get("address")

        return {
            "full_name": personal_info.get("fullName"),
            "email": personal_info.get("email"),
            "phone": personal_info.get("phone"),
            "location": location,
            "linkedin_url": personal_info.get("linkedin"),
            "github_url": personal_info.get("github"),
            "portfolio_url": personal_info.get("portfolio") or personal_info.get("website"),
            "summary": summary_section.get("text") if isinstance(summary_section, dict) else None,
            "skills": resume_data.get("skills"),
            "education": resume_data.get("education"),
            "experience": resume_data.get("workExperience") or resume_data.get("experience"),
            "projects": resume_data.get("projects"),
            "certifications": resume_data.get("certifications"),
        }

    # -----------------------------------------------------------
    # CRUD
    # -----------------------------------------------------------

    def create_resume(self, user: User, payload: ResumeCreate) -> Resume:
        """Create a new resume owned by `user`."""
        fields = payload.model_dump()
        fields.update(self._extract_denormalized_fields(payload.resume_data))
        return self.resume_repository.create_resume(user_id=user.id, fields=fields)

    def _get_owned_resume_or_raise(self, resume_id: uuid.UUID, user: User) -> Resume:
        """Fetch a resume and verify `user` owns it, or raise the appropriate error."""
        resume = self.resume_repository.get_resume_by_id(resume_id)
        if resume is None:
            raise ResumeNotFoundError(f"No resume found for id {resume_id!r}.")
        if resume.user_id != user.id:
            raise ResumeAccessDeniedError("You do not have access to this resume.")
        return resume

    def get_resume(self, resume_id: uuid.UUID, user: User) -> Resume:
        """Fetch a single resume, only if `user` owns it."""
        return self._get_owned_resume_or_raise(resume_id, user)

    def get_user_resumes(self, user: User) -> list[Resume]:
        """Fetch every resume owned by `user`."""
        return self.resume_repository.get_user_resumes(user.id)

    def update_resume(self, resume_id: uuid.UUID, user: User, payload: ResumeUpdate) -> Resume:
        """Update a resume, only if `user` owns it."""
        resume = self._get_owned_resume_or_raise(resume_id, user)

        fields = payload.model_dump(exclude_unset=True)
        if "resume_data" in fields and fields["resume_data"] is not None:
            fields.update(self._extract_denormalized_fields(fields["resume_data"]))

        return self.resume_repository.update_resume(resume, fields)

    def delete_resume(self, resume_id: uuid.UUID, user: User) -> None:
        """Delete a resume, only if `user` owns it."""
        resume = self._get_owned_resume_or_raise(resume_id, user)
        self.resume_repository.delete_resume(resume)

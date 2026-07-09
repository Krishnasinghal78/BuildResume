"""
Resume repository.

Owns all direct database access for the `resumes` table. Contains no
business rules (ownership checks, denormalized-field extraction,
etc.) -- that logic belongs in app/services/resume_service.py. This
layer only knows how to read and write rows.
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.resume import Resume


class ResumeRepository:
    """Database access for the `resumes` table."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def create_resume(self, user_id: uuid.UUID, fields: dict[str, Any]) -> Resume:
        """Persist a new resume row owned by `user_id`."""
        resume = Resume(user_id=user_id, **fields)
        self.db.add(resume)
        self.db.commit()
        self.db.refresh(resume)
        return resume

    def get_resume_by_id(self, resume_id: uuid.UUID) -> Resume | None:
        """Return the resume with this id, or None if no such resume exists."""
        stmt = select(Resume).where(Resume.id == resume_id)
        return self.db.execute(stmt).scalar_one_or_none()

    def get_user_resumes(self, user_id: uuid.UUID) -> list[Resume]:
        """Return every resume owned by `user_id`, most recently updated first."""
        stmt = (
            select(Resume)
            .where(Resume.user_id == user_id)
            .order_by(Resume.updated_at.desc())
        )
        return list(self.db.execute(stmt).scalars().all())

    def update_resume(self, resume: Resume, fields: dict[str, Any]) -> Resume:
        """Apply `fields` onto an already-fetched resume row and persist it."""
        for key, value in fields.items():
            setattr(resume, key, value)
        self.db.add(resume)
        self.db.commit()
        self.db.refresh(resume)
        return resume

    def delete_resume(self, resume: Resume) -> None:
        """Remove a resume row."""
        self.db.delete(resume)
        self.db.commit()

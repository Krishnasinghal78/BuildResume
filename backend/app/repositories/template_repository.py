"""
Template repository.

Owns all direct database access for the `templates` table. Templates
are read-only reference data from the public API's point of view, so
this repository only needs read methods.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.template import Template


class TemplateRepository:
    """Database access for the `templates` table."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_all_active(self) -> list[Template]:
        """Return every currently-active template, alphabetically by name."""
        stmt = select(Template).where(Template.is_active.is_(True)).order_by(Template.name)
        return list(self.db.execute(stmt).scalars().all())

    def get_by_id(self, template_id: uuid.UUID) -> Template | None:
        """Return the template with this id, or None if no such template exists."""
        stmt = select(Template).where(Template.id == template_id)
        return self.db.execute(stmt).scalar_one_or_none()

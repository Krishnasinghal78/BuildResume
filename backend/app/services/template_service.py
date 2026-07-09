"""
Template service.

Templates are read-only reference data from the public API's point of
view, so there's very little "business logic" here -- this class
exists mainly so app/api/v1/templates.py stays consistent with every
other route module (thin HTTP layer calling a service, never a
repository directly).
"""

import uuid

from sqlalchemy.orm import Session

from app.models.template import Template
from app.repositories.template_repository import TemplateRepository


class TemplateNotFoundError(Exception):
    """Raised when a template id doesn't match any active template."""


class TemplateService:
    """Business logic for reading resume templates."""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.template_repository = TemplateRepository(db)

    def list_templates(self) -> list[Template]:
        """Return every currently-active template."""
        return self.template_repository.get_all_active()

    def get_template(self, template_id: uuid.UUID) -> Template:
        """
        Fetch a single active template.

        Raises:
            TemplateNotFoundError: no active template matches `template_id`.
        """
        template = self.template_repository.get_by_id(template_id)
        if template is None or not template.is_active:
            raise TemplateNotFoundError(f"No template found for id {template_id!r}.")
        return template

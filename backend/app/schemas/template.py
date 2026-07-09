"""
Pydantic schema for Template read payloads.

Templates are reference data managed by the backend/admin tooling in
a later phase, not created via the public API in Phase 1 -- so only a
read schema exists here.
"""

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict


class TemplateRead(BaseModel):
    """Public representation of a resume template."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    category: str
    description: Optional[str] = None
    preview_image: Optional[str] = None
    html_template_path: Optional[str] = None
    is_active: bool
    created_at: datetime
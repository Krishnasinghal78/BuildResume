"""
SQLAlchemy declarative base.

Every ORM model in `app/models/` inherits from `Base`. Keeping the
base in its own module (rather than defining it inline in a models
file) avoids circular imports between models and lets Alembic import
a single, stable object for autogeneration.

IMPORTANT: this module must NOT import any model. Models import
`Base` from here (`from app.db.base import Base`); if this file also
imported a model at the top level, that model's own import of `Base`
would trigger a circular import the moment anything imports the
model directly (e.g. `from app.models.user import User` in a test or
service), rather than only via this module. Instead, whatever needs
every model registered on `Base.metadata` -- `init_db.py` and (in a
later phase) Alembic's `env.py` -- imports each model module directly
itself, right before it needs `Base.metadata` to be complete.
"""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Declarative base class for all ORM models."""

    pass
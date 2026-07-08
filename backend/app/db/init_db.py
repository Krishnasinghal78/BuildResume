"""
Database initialization.

Development-time convenience for creating all tables directly from
the ORM models via `Base.metadata.create_all()`. This is NOT a
replacement for Alembic migrations -- once Alembic is introduced,
schema changes should go through migrations, and this function
becomes primarily useful for spinning up a fresh local/test database
quickly, or for automated test suites that want a throwaway schema.

Run directly with:
    python -m app.db.init_db
"""

import logging

from app.db.base import Base
from app.db.session import engine

# Importing the app.models package registers every model on
# Base.metadata before create_all() runs -- see app/models/__init__.py
# for exactly why this single import is guaranteed to be enough.
import app.models  # noqa: F401

logger = logging.getLogger("buildresume")


def init_db() -> None:
    """
    Create all tables defined on `Base.metadata` that don't already exist.

    Safe to call multiple times: `create_all()` only creates tables
    that are missing and never touches existing ones.
    """
    logger.info("Creating database tables (if they don't already exist)...")
    Base.metadata.create_all(bind=engine)

    table_names = sorted(Base.metadata.tables.keys())
    logger.info("Database ready. Tables managed by SQLAlchemy: %s", table_names)


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-8s | %(message)s",
    )
    init_db()
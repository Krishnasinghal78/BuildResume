"""
Database engine and session management.

Provides:
  - `engine`      : the single SQLAlchemy Engine for the app.
  - `SessionLocal`: a session factory bound to that engine.
  - `get_db()`    : a FastAPI dependency that yields a request-scoped
                    Session and guarantees it is closed afterwards.
"""

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings

# `pool_pre_ping` avoids handing out stale/dead connections after the
# database has restarted or an idle connection has been dropped by a
# firewall/proxy -- a very common source of intermittent 500s in
# production if omitted.
engine = create_engine(
    settings.DATABASE_URL,
    pool_pre_ping=True,
    future=True,
)

SessionLocal = sessionmaker(
    bind=engine,
    autocommit=False,
    autoflush=False,
    future=True,
)


def get_db() -> Generator[Session, None, None]:
    """
    FastAPI dependency that provides a database session per request.

    Usage:
        @router.get("/example")
        def example(db: Session = Depends(get_db)):
            ...

    The session is always closed after the request finishes, even if
    an exception is raised, so connections are never leaked back to
    the pool in a dirty state.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
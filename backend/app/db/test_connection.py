"""
Standalone script to verify database connectivity before any API
endpoints exist. Prints the connected database name, the PostgreSQL
server version, and every table currently visible to SQLAlchemy.

Run directly with:
    python -m app.db.test_connection
"""

import logging

from sqlalchemy import inspect, text

from app.db.session import engine

logger = logging.getLogger("buildresume")


def test_connection() -> None:
    """Connect to the configured database and report what's there."""
    logger.info("Attempting to connect to the database...")

    with engine.connect() as connection:
        current_db = connection.execute(text("SELECT current_database()")).scalar_one()
        server_version = connection.execute(text("SHOW server_version")).scalar_one()

    logger.info("Connection successful.")
    logger.info("Current database name: %s", current_db)
    logger.info("PostgreSQL server version: %s", server_version)

    inspector = inspect(engine)
    table_names = sorted(inspector.get_table_names())

    if table_names:
        logger.info("Tables discovered (%d): %s", len(table_names), ", ".join(table_names))
    else:
        logger.warning(
            "No tables found in this database yet. Run "
            "`python -m app.db.init_db` to create them."
        )


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-8s | %(message)s",
    )
    test_connection()
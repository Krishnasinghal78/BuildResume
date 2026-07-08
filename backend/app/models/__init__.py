"""
Model package.

Importing a submodule always executes this package's __init__.py
first, so importing every model here -- rather than relying on
whoever imports models to remember to import all of them -- guarantees
that ANY of the following:

    from app.models.user import User
    from app.models import User
    from app.models.resume import Resume

...registers every model together, before SQLAlchemy ever tries to
configure the mappers (which resolve relationship strings like
relationship("Resume") by name against every model that's been
imported so far). Without this, importing just one model in
isolation -- e.g. in a test, or a service that only needs User --
raises `InvalidRequestError: ... failed to locate a name (...)` the
first time a query touches a relationship, because some other model
was never imported anywhere in that process.
"""

from app.models.user import User  # noqa: F401
from app.models.template import Template  # noqa: F401
from app.models.resume import Resume  # noqa: F401
from app.models.otp_code import OtpCode, OtpPurpose  # noqa: F401
from app.models.user_session import UserSession  # noqa: F401

__all__ = ["User", "Template", "Resume", "OtpCode", "OtpPurpose", "UserSession"]
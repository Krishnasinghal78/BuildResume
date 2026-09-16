"""
Gemini AI service.

Owns the one piece of business logic this phase needs: sending a
single user message to Google's Gemini API and returning its text
response. Nothing here talks HTTP -- no API route exists yet -- and
nothing here touches the database; this is intentionally the
smallest possible building block that a future AI endpoint (and,
later, resume-aware AI features) will sit on top of.

The API key never leaves the backend: it is read once from
`settings.GEMINI_API_KEY` (see app/core/config.py) and used only to
construct the Gemini client here. No route, schema, or frontend code
ever sees the raw key.
"""

import logging

from google import genai
from google.genai.errors import APIError

from app.core.config import settings

logger = logging.getLogger("buildresume.gemini")

# Model used for all Gemini calls in this service. Kept as a plain
# module constant rather than a Settings field since only one caller
# exists right now (none yet, in fact -- no endpoint calls this
# service this phase); promote it to app/core/config.py if/when
# different callers need different models.
GEMINI_MODEL = "gemini-2.5-flash"


class GeminiNotConfiguredError(Exception):
    """Raised when GEMINI_API_KEY is blank -- i.e. Gemini hasn't been set up for this environment."""


class GeminiServiceError(Exception):
    """Raised when a request to the Gemini API fails (network error, API-side error, empty response)."""


class GeminiService:
    """Sends a user message to Gemini and returns the model's text response."""

    def __init__(self) -> None:
        # The client is deliberately NOT constructed here. Building it
        # eagerly at import/startup time would mean any environment
        # with a blank GEMINI_API_KEY (the default -- see
        # app/core/config.py) fails to boot the whole app just because
        # Phase 4 hasn't been configured yet. It's built lazily on
        # first real use instead, inside _get_client().
        self._client: genai.Client | None = None

    def _get_client(self) -> genai.Client:
        if self._client is not None:
            return self._client

        if not settings.GEMINI_API_KEY:
            raise GeminiNotConfiguredError(
                "GEMINI_API_KEY is not set. Add it to your .env file to use Gemini AI features."
            )

        self._client = genai.Client(api_key=settings.GEMINI_API_KEY)
        return self._client

    def generate_response(self, message: str) -> str:
        """
        Send a single user message to Gemini and return its text
        response.

        Raises:
            GeminiNotConfiguredError: GEMINI_API_KEY is blank.
            GeminiServiceError: the request to Gemini failed (network
                error, API-side error, or an unexpectedly empty
                response).
        """
        client = self._get_client()

        try:
            response = client.models.generate_content(
                model=GEMINI_MODEL,
                contents=message,
            )
        except APIError as exc:
            logger.error("Gemini API request failed: %s", exc)
            raise GeminiServiceError(f"Gemini API request failed: {exc}") from exc
        except Exception as exc:  # network errors etc -- anything google-genai didn't wrap itself
            logger.error("Unexpected error calling Gemini API: %s", exc)
            raise GeminiServiceError(f"Unexpected error calling Gemini API: {exc}") from exc

        text = getattr(response, "text", None)
        if not text:
            raise GeminiServiceError("Gemini returned an empty response.")

        return text


_gemini_service_singleton: GeminiService | None = None


def get_gemini_service() -> GeminiService:
    """
    Returns a shared GeminiService instance, mirroring
    app/services/email_service.py's get_email_service() factory
    pattern (referenced in app/services/otp_service.py). Safe to call
    even when GEMINI_API_KEY is blank -- GeminiNotConfiguredError is
    only raised once generate_response() is actually called.
    """
    global _gemini_service_singleton
    if _gemini_service_singleton is None:
        _gemini_service_singleton = GeminiService()
    return _gemini_service_singleton

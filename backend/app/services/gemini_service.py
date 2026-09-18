"""
Gemini AI service.

Owns the business logic for sending a message to Google's Gemini API
and returning its text response, optionally grounded in a resume's
content. Nothing here talks HTTP, and nothing here touches the
database directly -- app/api/v1/ai.py fetches the resume (via
ResumeService, the same ownership-enforced path GET /resumes/{id}
uses) and passes its `resume_data` dict in here as plain data.

The API key never leaves the backend: it is read once from
`settings.GEMINI_API_KEY` (see app/core/config.py) and used only to
construct the Gemini client here. No route, schema, or frontend code
ever sees the raw key.
"""

import logging
from typing import Any, Optional

from google import genai
from google.genai.errors import APIError

from app.core.config import settings

logger = logging.getLogger("buildresume.gemini")

# Model used for all Gemini calls in this service. Kept as a plain
# module constant rather than a Settings field since only one caller
# exists right now; promote it to app/core/config.py if/when
# different callers need different models.
GEMINI_MODEL = "gemini-3.6-flash"

# Applied to every request, resume context or not -- keeps the
# assistant's tone/format consistent and its answers scannable.
GENERAL_INSTRUCTIONS = (
    "You are the AI assistant inside BuildResume, a resume-building app. "
    "Keep responses concise and easy to scan: short paragraphs, clear "
    "Markdown headings and bullet points where appropriate, and minimal "
    "unnecessary explanation. Aim for roughly 150-200 words unless the "
    "user explicitly asks for more detail."
)

# Appended only when resume context is available (see
# _format_resume_context below).
RESUME_CONTEXT_INSTRUCTIONS = (
    "The user's current resume content is provided below between <resume> "
    "tags. Answer based primarily on this actual resume: reference its "
    "real sections and content, and give specific, concrete "
    "recommendations rather than generic resume advice. Never invent "
    "experience, skills, projects, achievements, numbers, or technologies "
    "that are not present in the resume. If the resume does not contain "
    "enough information to answer well, say so clearly instead of guessing."
)


def _format_resume_context(resume_data: dict[str, Any]) -> str:
    """
    Turn a resume's `resume_data` JSONB blob into a compact, plain-text
    block for Gemini.

    Section keys and their sub-fields are taken directly from the
    frontend's own data shape -- RESUME_CONTENT_KEYS and the section
    rendering code in script.js, and the denormalization logic in
    ResumeService._extract_denormalized_fields() -- not guessed:
    personalInfo (fullName/email/phone/city/state/country/address/
    linkedin/github/portfolio/website), summary (plain text, or a
    {"text": ...} dict defensively), education (degree/branch/
    institution/location/cgpa), skills (category/items), projects
    (title/technologies/description), workExperience (company/role/
    location/description/responsibilities[].text), achievements
    (title/date/description), certifications (name/organization/
    issueDate/credentialUrl), languages (language/proficiency),
    extracurricular (activity/description).

    Only sections with actual, usable content are included -- nothing
    is fabricated for missing data, and empty/blank entries are
    filtered out the same way the frontend's own template renderers
    filter them (e.g. education entries need a degree or institution).
    """
    if not resume_data:
        return ""

    lines: list[str] = []

    personal = resume_data.get("personalInfo") or {}
    location = (
        ", ".join(
            part for part in [personal.get("city"), personal.get("state"), personal.get("country")] if part
        )
        or personal.get("address")
    )
    personal_bits = [
        personal.get("fullName"),
        personal.get("email"),
        personal.get("phone"),
        location,
        personal.get("linkedin"),
        personal.get("github"),
        personal.get("portfolio") or personal.get("website"),
    ]
    personal_bits = [bit for bit in personal_bits if bit]
    if personal_bits:
        lines.append("Personal Information: " + " | ".join(personal_bits))

    summary = resume_data.get("summary")
    summary_text = summary.get("text") if isinstance(summary, dict) else summary
    if summary_text and str(summary_text).strip():
        lines.append("\nProfessional Summary:\n" + str(summary_text).strip())

    education = [e for e in (resume_data.get("education") or []) if e.get("degree") or e.get("institution")]
    if education:
        lines.append("\nEducation:")
        for e in education:
            bits = [e.get("degree"), e.get("branch"), e.get("institution"), e.get("location"), e.get("cgpa")]
            lines.append("- " + ", ".join(bit for bit in bits if bit))

    skills = [c for c in (resume_data.get("skills") or []) if c.get("items")]
    if skills:
        lines.append("\nSkills:")
        for c in skills:
            items = ", ".join(c.get("items") or [])
            prefix = (c["category"] + ": ") if c.get("category") else ""
            lines.append("- " + prefix + items)

    projects = [p for p in (resume_data.get("projects") or []) if p.get("title")]
    if projects:
        lines.append("\nProjects:")
        for p in projects:
            header = p["title"] + (f" ({p['technologies']})" if p.get("technologies") else "")
            lines.append("- " + header)
            if p.get("description"):
                lines.append("  " + p["description"])

    work = [w for w in (resume_data.get("workExperience") or []) if w.get("company") or w.get("role")]
    if work:
        lines.append("\nWork Experience:")
        for w in work:
            header = " - ".join(bit for bit in [w.get("role"), w.get("company"), w.get("location")] if bit)
            lines.append("- " + header)
            if w.get("description"):
                lines.append("  " + w["description"])
            for r in w.get("responsibilities") or []:
                if r.get("text"):
                    lines.append("  * " + r["text"])

    achievements = [a for a in (resume_data.get("achievements") or []) if a.get("title")]
    if achievements:
        lines.append("\nAchievements:")
        for a in achievements:
            entry = a["title"]
            if a.get("date"):
                entry += f" ({a['date']})"
            if a.get("description"):
                entry += " -- " + a["description"]
            lines.append("- " + entry)

    certifications = [c for c in (resume_data.get("certifications") or []) if c.get("name")]
    if certifications:
        lines.append("\nCertifications:")
        for c in certifications:
            entry = c["name"]
            if c.get("organization"):
                entry += " -- " + c["organization"]
            if c.get("issueDate"):
                entry += f" ({c['issueDate']})"
            lines.append("- " + entry)

    languages = [l for l in (resume_data.get("languages") or []) if l.get("language")]
    if languages:
        lines.append("\nLanguages:")
        for l in languages:
            entry = l["language"]
            if l.get("proficiency"):
                entry += f" ({l['proficiency']})"
            lines.append("- " + entry)

    extracurricular = [e for e in (resume_data.get("extracurricular") or []) if e.get("activity")]
    if extracurricular:
        lines.append("\nExtracurricular Activities:")
        for e in extracurricular:
            entry = e["activity"]
            if e.get("description"):
                entry += " -- " + e["description"]
            lines.append("- " + entry)

    return "\n".join(lines).strip()


class GeminiNotConfiguredError(Exception):
    """Raised when GEMINI_API_KEY is blank -- i.e. Gemini hasn't been set up for this environment."""


class GeminiServiceError(Exception):
    """Raised when a request to the Gemini API fails (network error, API-side error, empty response)."""


class GeminiService:
    """Sends a user message to Gemini, optionally grounded in resume context, and returns its text response."""

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

    def generate_response(self, message: str, resume_data: Optional[dict[str, Any]] = None) -> str:
        """
        Send a user message to Gemini and return its text response.

        If `resume_data` is provided (the resume's `resume_data` JSONB
        blob -- see app/schemas/resume.py) and contains usable content,
        it's formatted into a compact text block and included as
        context, with instructions telling Gemini to ground its answer
        in it rather than giving generic advice. If `resume_data` is
        None, or formats down to nothing usable, behavior is identical
        to before this parameter existed.

        Raises:
            GeminiNotConfiguredError: GEMINI_API_KEY is blank.
            GeminiServiceError: the request to Gemini failed (network
                error, API-side error, or an unexpectedly empty
                response).
        """
        client = self._get_client()

        prompt_parts = [GENERAL_INSTRUCTIONS]
        if resume_data:
            resume_context = _format_resume_context(resume_data)
            if resume_context:
                prompt_parts.append(RESUME_CONTEXT_INSTRUCTIONS)
                prompt_parts.append("<resume>\n" + resume_context + "\n</resume>")
        prompt_parts.append("User message: " + message)
        full_prompt = "\n\n".join(prompt_parts)

        try:
            response = client.models.generate_content(
                model=GEMINI_MODEL,
                contents=full_prompt,
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
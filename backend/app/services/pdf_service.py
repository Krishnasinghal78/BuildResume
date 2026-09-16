"""
PDF export service.

Orchestrates POST /resumes/{id}/export/pdf: fetches the resume
(reusing ResumeService's existing ownership check -- not duplicated
here), fetches the selected template, builds a Jinja2 context that
applies each field's rich-text formatting (bold/italic/underline/
strike/color/highlight/font-size/letter-spacing) via app.utils.rich_text,
and converts the rendered HTML to PDF bytes via app.utils.pdf_utils.

NOTE on resume_data's shape: Phase 1B deliberately typed resume_data
as a loosely-validated dict (see schemas/resume.py) so the backend
never has to be updated in lockstep with frontend field-naming
changes. In practice this means resume_data on file varies along (at
least) two axes:

  1. Key naming -- "fullName" vs "full_name", "startDate" vs
     "start_date", etc. `_first_of()` tries a short list of plausible
     aliases per field.

  2. Shape -- the same logical field can appear as either the
     frontend's nested/structured form (e.g. `personalInfo: {...}`,
     `summary: {text: "..."}` , `skills: {languages: [...]}`) or a
     flatter/legacy form (e.g. top-level `full_name`, a bare
     `summary` string, `skills` as a plain list). This is what
     `_as_dict()`, `_as_text()`, and `_normalize_skills()` exist to
     absorb -- every place a nested object's `.get(...)` is called
     goes through one of these first, so a string/list/None showing
     up where a dict was expected degrades to "render it sensibly"
     rather than crashing with an AttributeError.

If your frontend's actual key names or shapes differ from what's
covered here, this is the one file to extend -- nothing elsewhere
needs to change.
"""

import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.models.resume import Resume
from app.models.template import Template
from app.models.user import User
from app.services.resume_service import ResumeService
from app.services.template_service import TemplateService
from app.utils.pdf_utils import convert_html_to_pdf, render_resume_html
from app.utils.rich_text import get_field_segments, render_field, sanitize_url

DEFAULT_TEMPLATE_FILENAME = "professional.html"


class PDFGenerationError(Exception):
    """Raised when HTML rendering or WeasyPrint conversion fails."""


def _as_dict(value: Any) -> dict[str, Any]:
    """Return `value` if it's already a dict, else an empty dict.

    Guards every nested `.get(...)` call in this file against a field
    that's supposed to be an object but is actually a string, list,
    None, or anything else in some stored resume -- the exact shape of
    bug this module exists to absorb.
    """
    return value if isinstance(value, dict) else {}


def _as_text(value: Any) -> str:
    """
    Coerce a field that may be EITHER a plain string OR a small
    `{"text": "..."}`-shaped object (the frontend's rich-text field
    convention) into a plain string.

    - "some text"              -> "some text"
    - {"text": "some text"}    -> "some text"
    - {"content": "..."}       -> "..." (alternate key some data uses)
    - None / {} / anything else -> ""
    """
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("text", "content", "value"):
            inner = value.get(key)
            if isinstance(inner, str):
                return inner
    return ""


def _as_list(value: Any) -> list[Any]:
    """Return `value` if it's already a list, else an empty list."""
    return value if isinstance(value, list) else []


def _normalize_skills(skills: Any) -> dict[str, Any]:
    """
    Accept skills in either shape the frontend/legacy data may use:
      - {"languages": ["C++", "Python"], "tools": [...]}  (categorized)
      - ["C++", "Python", "FastAPI"]                       (flat list)
    and always return a dict, since the Jinja templates iterate
    `skills.items()` -- a flat list is wrapped under one "Skills" label
    so it renders exactly like a single category.
    """
    if isinstance(skills, dict):
        return skills
    if isinstance(skills, list) and skills:
        return {"Skills": skills}
    return {}


def _first_of(d: dict[str, Any] | None, *keys: str, default: Any = "") -> Any:
    """Return the first present, non-None value among `keys` in dict `d`.

    Defaults to "" (not None) because every value here ultimately goes
    straight into a Jinja template for direct display -- an explicit
    Python `None` renders as the literal text "None" in HTML, which is
    never what's wanted; a missing/empty value should render as nothing.
    """
    if not isinstance(d, dict):
        return default
    for key in keys:
        if d.get(key) not in (None, ""):
            return d[key]
    return default


class PDFExportService:
    """Business logic for rendering a resume + template into a downloadable PDF."""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.resume_service = ResumeService(db)
        self.template_service = TemplateService(db)

    def export_resume_as_pdf(self, resume_id: uuid.UUID, user: User) -> tuple[bytes, str]:
        """
        Generate a PDF for `resume_id`, only if `user` owns it.

        Returns (pdf_bytes, suggested_filename).

        Raises:
            ResumeNotFoundError / ResumeAccessDeniedError: see ResumeService.
            TemplateNotFoundError: the resume's template_id doesn't
                resolve to an active template (only raised if
                template_id is set but invalid -- a resume with no
                template_id at all falls back to a default template).
            PDFGenerationError: HTML rendering or the WeasyPrint
                HTML->PDF conversion itself failed.
        """
        resume = self.resume_service.get_resume(resume_id=resume_id, user=user)

        template_filename = DEFAULT_TEMPLATE_FILENAME
        if resume.template_id is not None:
            template = self.template_service.get_template(resume.template_id)
            template_filename = template.html_template_path or DEFAULT_TEMPLATE_FILENAME
            # html_template_path is stored as e.g. "templates/modern.html"
            # (see the Phase 2 seed data); the PDF Jinja loader is rooted
            # at app/templates/pdf/, so only the filename itself is needed.
            template_filename = template_filename.rsplit("/", 1)[-1]

        try:
            context = self._build_context(resume)
            html_content = render_resume_html(template_filename, context)
            pdf_bytes = convert_html_to_pdf(html_content)
        except PDFGenerationError:
            raise
        except Exception as exc:  # noqa: BLE001 - WeasyPrint/Jinja can raise many distinct types
            raise PDFGenerationError(f"Failed to generate PDF: {exc}") from exc

        safe_title = "".join(c for c in (resume.title or "Resume") if c.isalnum() or c in " -_()").strip()
        filename = f"{safe_title or 'Resume'}.pdf"
        return pdf_bytes, filename

    # -----------------------------------------------------------
    # Context building
    # -----------------------------------------------------------

    def _build_context(self, resume: Resume) -> dict[str, Any]:
        data = _as_dict(resume.resume_data)
        formatting = _as_dict(resume.formatting_data)

        # personal_info merges TWO possible shapes of the same data:
        #   - frontend/structured: data["personalInfo"] = {"fullName": ..., ...}
        #   - legacy/flat:         data["full_name"], data["email"], ... at the top level
        # personalInfo's own keys win if both happen to be present.
        legacy_personal_info = {
            "fullName": data.get("full_name"),
            "email": data.get("email"),
            "phone": data.get("phone"),
            "linkedin": data.get("linkedin_url"),
            "github": data.get("github_url"),
            "portfolio": data.get("portfolio_url"),
        }
        personal_info = {
            **{k: v for k, v in legacy_personal_info.items() if v},
            **_as_dict(data.get("personalInfo")),
        }

        return {
            "resume_title": resume.title,
            "full_name": _first_of(personal_info, "fullName", "full_name", default=resume.full_name or ""),
            "email": _first_of(personal_info, "email", default=resume.email or ""),
            "phone": _first_of(personal_info, "phone", default=resume.phone or ""),
            "location": self._build_location(personal_info) or data.get("location") or resume.location or "",
            "linkedin_url": sanitize_url(_first_of(personal_info, "linkedin", "linkedinUrl")),
            "github_url": sanitize_url(_first_of(personal_info, "github", "githubUrl")),
            "portfolio_url": sanitize_url(_first_of(personal_info, "portfolio", "website", "portfolioUrl")),
            "summary_html": render_field(formatting, "summary.text", _as_text(data.get("summary"))),
            "education": self._build_education(data.get("education")),
            "experience": self._build_experience(data.get("workExperience") or data.get("experience"), formatting),
            "projects": self._build_projects(data.get("projects"), formatting),
            "achievements": self._build_achievements(data.get("achievements"), formatting),
            "extracurricular": self._build_extracurricular(data.get("extracurricular"), formatting),
            "certifications": _as_list(data.get("certifications")),
            "skills": _normalize_skills(data.get("skills")),
        }

    @staticmethod
    def _build_location(personal_info: dict[str, Any]) -> str:
        parts = [personal_info.get("city"), personal_info.get("state"), personal_info.get("country")]
        joined = ", ".join(p for p in parts if isinstance(p, str) and p)
        return joined or (personal_info.get("address") or "")

    @staticmethod
    def _build_education(items: Any) -> list[dict[str, Any]]:
        out = []
        for item in _as_list(items):
            if not isinstance(item, dict):
                continue
            start_date = _first_of(item, "startDate", "start_date", default="")
            end_date = _first_of(item, "endDate", "end_date", default="")
            if not start_date and not end_date:
                # Legacy shape: a single combined "duration" string
                # (e.g. "2023-2027") instead of separate start/end
                # fields -- shown as-is in the date slot.
                start_date = _first_of(item, "duration", default="")
            out.append({
                "degree": _first_of(item, "degree", "qualification"),
                "institution": _first_of(item, "institution", "school", "schoolName"),
                "location": _first_of(item, "location"),
                "start_date": start_date,
                "end_date": end_date,
                "grade": _first_of(item, "cgpa", "percentage", "grade"),
            })
        return out

    @staticmethod
    def _build_experience(items: Any, formatting: dict[str, Any]) -> list[dict[str, Any]]:
        out = []
        for idx, item in enumerate(_as_list(items)):
            if not isinstance(item, dict):
                continue
            item_id = item.get("id") or f"idx{idx}"
            responsibilities = _as_list(item.get("responsibilities"))
            description_text = _as_text(item.get("description"))
            out.append({
                "job_title": _first_of(item, "jobTitle", "title", "role"),
                "company": _first_of(item, "company", "companyName", "organization"),
                "location": _first_of(item, "location"),
                "start_date": _first_of(item, "startDate", "start_date", default=""),
                "end_date": _first_of(item, "endDate", "end_date", default=""),
                "description_html": render_field(
                    formatting, f"workExperience[{item_id}].description", description_text
                ) if description_text else "",
                "responsibilities_html": [
                    render_field(
                        formatting,
                        f"workExperience[{item_id}].responsibilities[{r.get('id') if isinstance(r, dict) else ridx}].text",
                        _as_text(r) if isinstance(r, str) else _as_text(r.get("text")) if isinstance(r, dict) else "",
                    )
                    for ridx, r in enumerate(responsibilities)
                    if (isinstance(r, str) and r) or (isinstance(r, dict) and r.get("text"))
                ],
            })
        return out

    @staticmethod
    def _build_projects(items: Any, formatting: dict[str, Any]) -> list[dict[str, Any]]:
        out = []
        for idx, item in enumerate(_as_list(items)):
            if not isinstance(item, dict):
                continue
            item_id = item.get("id") or f"idx{idx}"
            bullets = _as_list(item.get("bullets"))
            description_text = _as_text(item.get("description"))
            out.append({
                "name": _first_of(item, "name", "title", "projectName"),
                "tech_stack": _first_of(item, "techStack", "technologies", "tech"),
                "start_date": _first_of(item, "startDate", "start_date", default=""),
                "end_date": _first_of(item, "endDate", "end_date", default=""),
                "github_url": sanitize_url(_first_of(item, "githubUrl", "github")),
                "live_url": sanitize_url(_first_of(item, "liveUrl", "demoUrl", "url")),
                "description_html": render_field(
                    formatting, f"projects[{item_id}].description", description_text
                ) if description_text else "",
                "bullets_html": [
                    render_field(
                        formatting,
                        f"projects[{item_id}].bullets[{b.get('id') if isinstance(b, dict) else bidx}].text",
                        _as_text(b) if isinstance(b, str) else _as_text(b.get("text")) if isinstance(b, dict) else "",
                    )
                    for bidx, b in enumerate(bullets)
                    if (isinstance(b, str) and b) or (isinstance(b, dict) and b.get("text"))
                ],
            })
        return out

    @staticmethod
    def _build_achievements(items: Any, formatting: dict[str, Any]) -> list[dict[str, Any]]:
        out = []
        for idx, item in enumerate(_as_list(items)):
            if isinstance(item, str):
                # Legacy shape: a bare list of strings, e.g. ["Solved 400+ problems"].
                if item:
                    out.append({"title": item, "date": "", "description_html": ""})
                continue
            if not isinstance(item, dict):
                continue
            item_id = item.get("id") or f"idx{idx}"
            description_text = _as_text(item.get("description"))
            out.append({
                "title": _first_of(item, "title", "name"),
                "date": _first_of(item, "date", default=""),
                "description_html": render_field(
                    formatting, f"achievements[{item_id}].description", description_text
                ) if description_text else "",
            })
        return out

    @staticmethod
    def _build_extracurricular(items: Any, formatting: dict[str, Any]) -> list[dict[str, Any]]:
        out = []
        for idx, item in enumerate(_as_list(items)):
            if isinstance(item, str):
                if item:
                    out.append({"title": item, "organization": "", "description_html": ""})
                continue
            if not isinstance(item, dict):
                continue
            item_id = item.get("id") or f"idx{idx}"
            description_text = _as_text(item.get("description"))
            out.append({
                "title": _first_of(item, "title", "role", "name"),
                "organization": _first_of(item, "organization", "org"),
                "description_html": render_field(
                    formatting, f"extracurricular[{item_id}].description", description_text
                ) if description_text else "",
            })
        return out

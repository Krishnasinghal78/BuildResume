"""
PDF rendering mechanics: Jinja2 HTML rendering + WeasyPrint HTML->PDF
conversion. Pure, reusable functions only -- no DB access, no
ownership checks, no knowledge of "a resume" as a concept. That
orchestration lives in app/services/pdf_service.py.

Engine choice: WeasyPrint. It gives the most faithful CSS 2.1/3
rendering (flexbox, full-bleed layouts, etc) of the options
considered, which matters for template fidelity. The trade-off is
that it depends on native GTK/Pango/Cairo libraries that aren't
installed by `pip install` alone -- see the project README / setup
docs for the Windows installation steps (MSYS2 + PATH setup) needed
alongside this file.
"""

from pathlib import Path
from typing import Any

import logging

from jinja2 import Environment, FileSystemLoader, select_autoescape
from weasyprint import HTML

logging.getLogger("weasyprint").setLevel(logging.WARNING)

_TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates" / "pdf"

# autoescape=True is a deliberate second layer of defense: every value
# placed into a Jinja template is HTML-escaped by default unless
# explicitly marked safe with `| safe` (used only for the pre-sanitized
# HTML strings produced by app.utils.rich_text). Combined with that
# module's allow-listing, this means untrusted resume content can
# never inject arbitrary markup into the rendered PDF.
_jinja_env = Environment(
    loader=FileSystemLoader(str(_TEMPLATES_DIR)),
    autoescape=select_autoescape(["html", "xml"]),
)


def render_resume_html(template_filename: str, context: dict[str, Any]) -> str:
    """
    Render a resume's Jinja2 template with `context` into an HTML string.

    `template_filename` is a filename relative to app/templates/pdf/
    (e.g. "modern.html") -- see Template.html_template_path, which
    stores exactly this.
    """
    template = _jinja_env.get_template(template_filename)
    return template.render(**context)


def convert_html_to_pdf(html_content: str) -> bytes:
    """
    Convert an HTML string into PDF bytes using WeasyPrint.

    Raises whatever WeasyPrint itself raises on malformed input --
    the caller (PDFExportService) is responsible for wrapping this in
    a domain-specific exception.
    """
    return HTML(string=html_content, base_url=str(_TEMPLATES_DIR)).write_pdf()

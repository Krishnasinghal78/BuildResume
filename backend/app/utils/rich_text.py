"""
Rich-text rendering utilities for PDF export.

Ports the frontend's offset-based formatting model (see the resume
builder's `renderFormattedText` / `formatting_data` design) into
Python: given a field's plain text plus its list of
`{start, end, bold, italic, underline, strike, color, background,
fontSize, letterSpacing}` segments, produce flat, non-nested
`<span style="...">` HTML -- the same rendering contract the frontend
already uses, so a PDF export looks exactly like the live preview.

Bare URLs and email addresses found anywhere in the text (plain or
inside a styled run) are additionally auto-linked into real `<a>`
tags -- see `_linkify()`.

SECURITY NOTE: unlike the frontend (where `resume_data`/
`formatting_data` only ever contain what the app's own editor
produced), this backend accepts arbitrary JSON over the API --
Phase 1B's schemas deliberately don't validate the internal shape of
`resume_data`/`formatting_data` (see schemas/resume.py). That means
every string used here is untrusted user input that ends up as real
HTML fed to WeasyPrint, so everything below allow-lists what it will
render rather than trusting the client -- text is always HTML-escaped,
style values must match a strict pattern before being emitted, and
URLs (whether from a known field like `linkedin_url` or auto-detected
inside free text) must use an allowed scheme before becoming an
`<a href>`.
"""

import html
import re
from typing import Any

_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_RGB_COLOR_RE = re.compile(
    r"^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$"
)
_PX_SIZE_RE = re.compile(r"^-?\d{1,3}(?:\.\d+)?px$")
_NAMED_COLORS = {
    "black", "white", "red", "green", "blue", "yellow", "orange", "purple",
    "pink", "brown", "gray", "grey", "navy", "teal", "maroon", "lime",
    "olive", "silver", "gold", "indigo", "violet", "transparent",
}

_ALLOWED_URL_SCHEMES = ("http://", "https://", "mailto:", "tel:")

# Matches a bare URL (http(s):// or www.-prefixed) OR a bare email
# address, as two alternatives of one pattern so a single left-to-right
# scan can't double-match overlapping text. Deliberately NOT anchored
# to word boundaries with lookaheads for exotic schemes -- it only
# ever recognizes literal "http://", "https://", or "www." at the
# match start, or a strict email shape, so there is no way for a
# crafted string (e.g. "javascript:https://evil") to make the emitted
# href be anything other than the matched http(s)/www/email token
# itself, which then still has to pass sanitize_url() below.
_LINKABLE_RE = re.compile(
    r"(?P<url>https?://[^\s<>\"']+|www\.[^\s<>\"']+)"
    r"|(?P<email>[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})",
    re.IGNORECASE,
)

# Trailing characters that are almost always sentence punctuation, not
# part of the URL/email itself (e.g. "...see https://x.com." or "(https://x.com)").
_TRAILING_PUNCTUATION = ".,;:!?)]}\"'"


def _is_safe_color(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    v = value.strip()
    return bool(_HEX_COLOR_RE.match(v) or _RGB_COLOR_RE.match(v) or v.lower() in _NAMED_COLORS)


def _is_safe_px_size(value: Any) -> bool:
    return isinstance(value, str) and bool(_PX_SIZE_RE.match(value.strip()))


def sanitize_url(url: Any) -> str | None:
    """
    Return `url` if it starts with an allowed scheme, else None.

    Protocol-relative and scheme-less values (e.g. "linkedin.com/in/x")
    are treated as "https://" + value, matching how a person would
    naturally type a profile URL without the scheme. Anything else
    (in particular "javascript:" or unrecognized schemes) is rejected.
    """
    if not isinstance(url, str) or not url.strip():
        return None
    value = url.strip()
    lowered = value.lower()
    if lowered.startswith(_ALLOWED_URL_SCHEMES):
        return value
    if "://" in lowered or lowered.startswith("javascript:") or lowered.startswith("data:"):
        return None
    # No scheme at all (e.g. "github.com/user") -- assume https.
    return f"https://{value}"


def _strip_trailing_punctuation(token: str) -> tuple[str, str]:
    """Split off any trailing punctuation so it isn't swallowed into a URL/email."""
    trail = ""
    while token and token[-1] in _TRAILING_PUNCTUATION:
        trail = token[-1] + trail
        token = token[:-1]
    return token, trail


def _linkify(raw_text: str) -> str:
    """
    Escape `raw_text` for safe HTML output, auto-linking any bare URL
    or email address found along the way into a real `<a href>`.

    This is the ONLY place plain text becomes HTML in this module --
    render_formatted_text() calls this instead of html.escape()
    directly for every run of text (both the unstyled gaps between
    segments and the content inside a styled segment), so auto-linking
    applies everywhere text is emitted, formatted or not.

    Safety: text is escaped first/around every match; only the exact
    matched token becomes a link, and its href still has to pass
    sanitize_url()'s scheme allow-list -- a match that fails that check
    (which shouldn't be possible given the regex, but defense in depth
    costs nothing) is rendered as plain escaped text instead of a link.
    """
    if not raw_text:
        return ""

    out: list[str] = []
    pos = 0
    for match in _LINKABLE_RE.finditer(raw_text):
        start, end = match.start(), match.end()
        if start < pos:
            continue  # defensive: regex shouldn't produce overlapping matches

        out.append(html.escape(raw_text[pos:start]))

        token, trail = _strip_trailing_punctuation(match.group(0))
        if not token:
            out.append(html.escape(match.group(0)))
            pos = end
            continue

        href = sanitize_url(f"mailto:{token}" if match.lastgroup == "email" else token)
        if href:
            out.append(f'<a href="{html.escape(href, quote=True)}">{html.escape(token)}</a>')
            out.append(html.escape(trail))
        else:
            out.append(html.escape(match.group(0)))

        pos = end

    out.append(html.escape(raw_text[pos:]))
    return "".join(out)


def _segment_style_css(segment: dict[str, Any]) -> str:
    """Build a safe inline `style="..."` value from one formatting segment."""
    css: list[str] = []

    if segment.get("bold"):
        css.append("font-weight:bold")
    if segment.get("italic"):
        css.append("font-style:italic")

    decorations = []
    if segment.get("underline"):
        decorations.append("underline")
    if segment.get("strike"):
        decorations.append("line-through")
    if decorations:
        css.append(f"text-decoration:{' '.join(decorations)}")

    color = segment.get("color")
    if _is_safe_color(color):
        css.append(f"color:{color}")

    background = segment.get("background")
    if _is_safe_color(background):
        css.append(f"background-color:{background}")

    font_size = segment.get("fontSize")
    if _is_safe_px_size(font_size):
        css.append(f"font-size:{font_size}")

    letter_spacing = segment.get("letterSpacing")
    if letter_spacing == "normal" or _is_safe_px_size(letter_spacing):
        css.append(f"letter-spacing:{letter_spacing}")

    return ";".join(css)


def render_formatted_text(text: str | None, segments: list[dict[str, Any]] | None) -> str:
    """
    Render plain text + offset segments into safe, flat HTML.

    Mirrors the frontend's own `renderFormattedText`: one <span> per
    styled run, never nested, with everything outside a styled range
    left as plain text -- except any bare URL/email is auto-linked
    (see `_linkify`), whether it falls inside a styled run or not.
    """
    text = text or ""
    if not segments:
        return _linkify(text)

    valid_segments = [
        s for s in segments
        if isinstance(s, dict) and isinstance(s.get("start"), int) and isinstance(s.get("end"), int)
        and 0 <= s["start"] < s["end"] <= len(text)
    ]
    if not valid_segments:
        return _linkify(text)

    valid_segments.sort(key=lambda s: s["start"])

    out: list[str] = []
    pos = 0
    for seg in valid_segments:
        start, end = seg["start"], seg["end"]
        if start < pos:
            continue  # overlapping/out-of-order segment from untrusted input -- skip it
        if start > pos:
            out.append(_linkify(text[pos:start]))

        style = _segment_style_css(seg)
        run = _linkify(text[start:end])
        out.append(f'<span style="{style}">{run}</span>' if style else run)
        pos = end

    if pos < len(text):
        out.append(_linkify(text[pos:]))

    return "".join(out)


def get_field_segments(formatting_data: dict[str, Any] | None, path: str) -> list[dict[str, Any]]:
    """Look up the formatting segments for one field path (e.g. "summary.text")."""
    if not isinstance(formatting_data, dict):
        return []
    segments = formatting_data.get(path)
    return segments if isinstance(segments, list) else []


def render_field(
    formatting_data: dict[str, Any] | None,
    path: str,
    text: str | None,
) -> str:
    """Convenience wrapper: look up a field's segments and render it in one call."""
    return render_formatted_text(text, get_field_segments(formatting_data, path))

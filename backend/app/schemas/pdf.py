"""
Pydantic schema for PDF export error responses.

The success response of POST /resumes/{id}/export/pdf is raw binary
(`application/pdf`), not JSON, so there's no response_model for the
success case -- FastAPI's `Response` is used directly in the route.
This schema exists purely to document the error-response shape (the
same `{"detail": "..."}` every other endpoint in this codebase
already returns via HTTPException) in the OpenAPI/Swagger UI.
"""

from pydantic import BaseModel


class PDFExportErrorResponse(BaseModel):
    """Shape of an error response from the PDF export endpoint."""

    detail: str
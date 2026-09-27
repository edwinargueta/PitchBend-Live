"""The §6.6 error codes, the one API exception type, and the JSON error handlers.

Every non-2xx JSON body is ``{"error": {"code": ..., "message": ...}}``; ``RATE_LIMITED``
adds ``retry_after_s`` inside ``error`` plus a ``Retry-After`` header (ADR 0005 §2, §5).
Responses never carry stack traces.
"""

from enum import StrEnum

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class ErrorCode(StrEnum):
    INVALID_URL = "INVALID_URL"
    UNSUPPORTED_FILE = "UNSUPPORTED_FILE"
    FILE_TOO_LARGE = "FILE_TOO_LARGE"
    VIDEO_TOO_LONG = "VIDEO_TOO_LONG"
    LIVESTREAM = "LIVESTREAM"
    SOURCE_UNAVAILABLE = "SOURCE_UNAVAILABLE"
    SOURCE_BLOCKED = "SOURCE_BLOCKED"
    RATE_LIMITED = "RATE_LIMITED"
    KEY_DETECTION_FAILED = "KEY_DETECTION_FAILED"
    NOT_FOUND = "NOT_FOUND"
    INTERNAL = "INTERNAL"


# §6.6. KEY_DETECTION_FAILED is SSE-only and never an HTTP response.
HTTP_STATUS: dict[ErrorCode, int] = {
    ErrorCode.INVALID_URL: 400,
    ErrorCode.UNSUPPORTED_FILE: 400,
    ErrorCode.FILE_TOO_LARGE: 413,
    ErrorCode.VIDEO_TOO_LONG: 422,
    ErrorCode.LIVESTREAM: 422,
    ErrorCode.SOURCE_UNAVAILABLE: 422,
    ErrorCode.SOURCE_BLOCKED: 502,
    ErrorCode.RATE_LIMITED: 429,
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.INTERNAL: 500,
}

# Fatal pipeline errors end the SSE stream; KEY_DETECTION_FAILED never does (§6.5).
NON_FATAL: frozenset[str] = frozenset({ErrorCode.KEY_DETECTION_FAILED})

_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.INVALID_URL: "That isn't a recognizable YouTube video link.",
    ErrorCode.UNSUPPORTED_FILE: (
        "That isn't a supported audio file. Try MP3, WAV, M4A/AAC, FLAC or OGG/Opus."
    ),
    ErrorCode.FILE_TOO_LARGE: "That file is too large.",
    ErrorCode.VIDEO_TOO_LONG: "That song is too long.",
    ErrorCode.LIVESTREAM: "Live streams aren't supported.",
    ErrorCode.SOURCE_UNAVAILABLE: "That video is private, removed, or unavailable in this region.",
    ErrorCode.SOURCE_BLOCKED: (
        "YouTube blocked this request. Try uploading the audio file instead."
    ),
    ErrorCode.RATE_LIMITED: "Too many requests. Please wait and try again.",
    ErrorCode.KEY_DETECTION_FAILED: "The key couldn't be detected, but playback still works.",
    ErrorCode.NOT_FOUND: "Not found. It may have expired.",
    ErrorCode.INTERNAL: "Something went wrong. Please try again.",
}


def default_message(code: ErrorCode | str) -> str:
    try:
        return _MESSAGES[ErrorCode(code)]
    except ValueError:
        return _MESSAGES[ErrorCode.INTERNAL]


def limit_message(code: ErrorCode, *, max_upload_mb: int, max_duration_s: int) -> str:
    """Messages that quote the configured limits (§6.2 values, never hardcoded)."""
    if code is ErrorCode.FILE_TOO_LARGE:
        return f"That file is too large. The limit is {max_upload_mb} MB."
    if code is ErrorCode.VIDEO_TOO_LONG:
        minutes = max_duration_s // 60
        return f"That song is too long. The limit is {minutes} minutes."
    return default_message(code)


class ApiError(Exception):
    """The one exception type routes raise; rendered as the §6.6 body."""

    def __init__(
        self, code: ErrorCode, message: str | None = None, *, retry_after_s: int | None = None
    ) -> None:
        self.code = code
        self.message = message or default_message(code)
        self.retry_after_s = retry_after_s
        super().__init__(code.value)

    @property
    def status_code(self) -> int:
        return HTTP_STATUS.get(self.code, 500)


def error_body(
    code: ErrorCode, message: str | None = None, *, retry_after_s: int | None = None
) -> dict[str, dict[str, object]]:
    error: dict[str, object] = {"code": code.value, "message": message or default_message(code)}
    if retry_after_s is not None:
        error["retry_after_s"] = retry_after_s
    return {"error": error}


def error_response(error: ApiError) -> JSONResponse:
    headers = {}
    if error.retry_after_s is not None:
        headers["Retry-After"] = str(error.retry_after_s)
    return JSONResponse(
        error_body(error.code, error.message, retry_after_s=error.retry_after_s),
        status_code=error.status_code,
        headers=headers,
    )


def _validation_code(request: Request) -> ErrorCode:
    # POST /api/jobs is the only route with a validated body; POST /api/uploads parses
    # its multipart stream by hand, but map it too in case that ever changes.
    if request.url.path.rstrip("/").endswith("/uploads"):
        return ErrorCode.UNSUPPORTED_FILE
    return ErrorCode.INVALID_URL


async def _handle_api_error(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ApiError)
    return error_response(exc)


async def _handle_validation_error(request: Request, exc: Exception) -> JSONResponse:
    return error_response(ApiError(_validation_code(request)))


async def _handle_http_error(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)
    if exc.status_code == 404:
        return error_response(ApiError(ErrorCode.NOT_FOUND))
    # 405 and friends: keep the status, use the §6.6 shape with the closest code.
    code = ErrorCode.INTERNAL if exc.status_code >= 500 else ErrorCode.NOT_FOUND
    return JSONResponse(
        error_body(code), status_code=exc.status_code, headers=getattr(exc, "headers", None)
    )


async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
    # Starlette's ServerErrorMiddleware re-raises after this handler, so uvicorn logs the
    # traceback once (as JSON, via pitchbend_live.logs); the client only sees INTERNAL.
    return error_response(ApiError(ErrorCode.INTERNAL))


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _handle_api_error)
    app.add_exception_handler(RequestValidationError, _handle_validation_error)
    app.add_exception_handler(StarletteHTTPException, _handle_http_error)
    app.add_exception_handler(Exception, _handle_unexpected)

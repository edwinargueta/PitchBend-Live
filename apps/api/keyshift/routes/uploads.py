"""``POST /api/uploads`` (ARCHITECTURE.md §6.4, §10 A4, ADR 0005 §11-12).

The multipart body is parsed **as it streams** with python-multipart's push parser
(FastAPI's ``UploadFile`` would buffer the whole body before the handler runs):

1. Rate limit, before a single body byte is read.
2. ``Content-Length`` over ``MAX_UPLOAD_MB`` (+ a multipart allowance): 413 at once.
3. The ``file`` part streams to ``TMP_DIR/.upload-<hex>.part`` while its SHA-256 is
   computed; the upload aborts with 413 the moment it passes the limit.
4. Magic-byte sniff, then ffprobe (>= 1 audio stream, allowed container, duration).
5. Dedup by ``up:<sha256[:16]>``; a new job's file moves to ``TMP_DIR/<job_id>/upload``
   and ``ingest_upload`` is enqueued.

Every failure path deletes the temp file.
"""

import asyncio
import hashlib
import os
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, BinaryIO

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from python_multipart.exceptions import FormParserError
from python_multipart.multipart import MultipartParser, parse_options_header
from starlette.requests import ClientDisconnect

from keyshift.audio.ffmpeg import FFmpegError
from keyshift.audio.sniff import SNIFF_BYTES, sniff_audio
from keyshift.errors import ApiError, ErrorCode, limit_message
from keyshift.queue import INGEST_UPLOAD
from keyshift.routes.common import JobAccepted, ServicesDep, enforce_rate_limit, ingest
from keyshift.storage import remove_path, staged_upload_path
from keyshift.titles import sanitize_title

if TYPE_CHECKING:  # defined only for type checkers in python-multipart
    from python_multipart.multipart import MultipartCallbacks

router = APIRouter(tags=["uploads"])

FILE_FIELD = b"file"
# Multipart framing (boundaries, part headers) plus any small extra form fields.
MULTIPART_ALLOWANCE = 64 * 1024


class _TooLarge(Exception):
    pass


@dataclass(frozen=True)
class ReceivedUpload:
    path: Path
    size: int
    sha256: str
    filename: str | None
    head: bytes  # the first SNIFF_BYTES of the file, for magic-byte sniffing


class _FilePartReceiver:
    """python-multipart callbacks: collect the first ``file`` part's bytes, count them,
    and discard everything else (within ``MULTIPART_ALLOWANCE``)."""

    def __init__(self, max_bytes: int) -> None:
        self.max_bytes = max_bytes
        self.pending: list[bytes] = []
        self.size = 0
        self.file_seen = False
        self.filename: str | None = None
        self.finished = False
        self._other_bytes = 0
        self._in_file = False
        self._field = bytearray()
        self._value = bytearray()
        self._headers: dict[bytes, bytes] = {}

    def callbacks(self) -> "MultipartCallbacks":
        return {
            "on_part_begin": self._on_part_begin,
            "on_header_field": self._on_header_field,
            "on_header_value": self._on_header_value,
            "on_header_end": self._on_header_end,
            "on_headers_finished": self._on_headers_finished,
            "on_part_data": self._on_part_data,
            "on_part_end": self._on_part_end,
            "on_end": self._on_end,
        }

    def _on_part_begin(self) -> None:
        self._headers = {}
        self._in_file = False

    def _on_header_field(self, data: bytes, start: int, end: int) -> None:
        self._field += data[start:end]

    def _on_header_value(self, data: bytes, start: int, end: int) -> None:
        self._value += data[start:end]

    def _on_header_end(self) -> None:
        self._headers[bytes(self._field).strip().lower()] = bytes(self._value).strip()
        self._field.clear()
        self._value.clear()

    def _on_headers_finished(self) -> None:
        disposition, params = parse_options_header(self._headers.get(b"content-disposition"))
        if disposition == b"form-data" and params.get(b"name") == FILE_FIELD and not self.file_seen:
            self._in_file = True
            self.file_seen = True
            raw_name = params.get(b"filename")
            self.filename = raw_name.decode("utf-8", "replace") if raw_name is not None else None

    def _on_part_data(self, data: bytes, start: int, end: int) -> None:
        if self._in_file:
            self.size += end - start
            if self.size > self.max_bytes:
                raise _TooLarge
            self.pending.append(data[start:end])
        else:
            self._other_bytes += end - start
            if self._other_bytes > MULTIPART_ALLOWANCE:
                raise _TooLarge

    def _on_part_end(self) -> None:
        self._in_file = False

    def _on_end(self) -> None:
        self.finished = True


def _open_exclusive(path: Path) -> BinaryIO:
    return open(path, "xb")


async def receive_upload(
    *,
    content_type: str | None,
    content_length: str | None,
    chunks: AsyncIterator[bytes],
    tmp_dir: Path,
    max_bytes: int,
) -> ReceivedUpload:
    """Stream a multipart body's ``file`` part to a temp file in ``tmp_dir``.

    Raises ``ApiError``: ``UNSUPPORTED_FILE`` for a non-multipart, malformed, truncated
    or file-less body; ``FILE_TOO_LARGE`` past ``max_bytes`` (declared or counted).
    No temp file survives an error.
    """
    mime, params = parse_options_header(content_type)
    boundary = params.get(b"boundary")
    if mime != b"multipart/form-data" or not boundary:
        raise ApiError(ErrorCode.UNSUPPORTED_FILE)
    body_limit = max_bytes + MULTIPART_ALLOWANCE
    if content_length is not None:
        try:
            declared = int(content_length)
        except ValueError:
            raise ApiError(ErrorCode.UNSUPPORTED_FILE) from None
        if declared > body_limit:
            raise ApiError(ErrorCode.FILE_TOO_LARGE)

    receiver = _FilePartReceiver(max_bytes)
    try:
        parser = MultipartParser(boundary, receiver.callbacks())
    except (ValueError, FormParserError):
        raise ApiError(ErrorCode.UNSUPPORTED_FILE) from None

    path = tmp_dir / f".upload-{uuid.uuid4().hex}.part"
    hasher = hashlib.sha256()
    head = bytearray()
    received = 0
    handle = await asyncio.to_thread(_open_exclusive, path)
    try:
        try:
            async for chunk in chunks:
                received += len(chunk)
                if received > body_limit:
                    raise _TooLarge
                parser.write(chunk)
                if receiver.pending:
                    data = b"".join(receiver.pending)
                    receiver.pending.clear()
                    hasher.update(data)
                    if len(head) < SNIFF_BYTES:
                        head += data[: SNIFF_BYTES - len(head)]
                    await asyncio.to_thread(handle.write, data)
            parser.finalize()
        except _TooLarge:
            raise ApiError(ErrorCode.FILE_TOO_LARGE) from None
        except (FormParserError, ClientDisconnect):
            raise ApiError(ErrorCode.UNSUPPORTED_FILE) from None
        if not (receiver.finished and receiver.file_seen and receiver.size > 0):
            raise ApiError(ErrorCode.UNSUPPORTED_FILE)
        await asyncio.to_thread(handle.close)
    except BaseException:
        handle.close()
        path.unlink(missing_ok=True)
        raise
    return ReceivedUpload(path, receiver.size, hasher.hexdigest(), receiver.filename, bytes(head))


def _stage(src: Path, dst: Path) -> None:
    dst.parent.mkdir(mode=0o750, exist_ok=True)
    os.replace(src, dst)


_OPENAPI_BODY = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "required": ["file"],
                    "properties": {"file": {"type": "string", "format": "binary"}},
                }
            }
        },
    }
}


@router.post(
    "/uploads",
    status_code=202,
    response_model=JobAccepted,
    responses={200: {"model": JobAccepted, "description": "Cache hit"}},
    openapi_extra=_OPENAPI_BODY,
)
async def create_upload(request: Request, services: ServicesDep) -> JSONResponse:
    settings = services.settings
    await enforce_rate_limit(services, request)  # before reading the body (ADR 0005 §2)

    limits = {"max_upload_mb": settings.MAX_UPLOAD_MB, "max_duration_s": settings.MAX_DURATION_S}
    try:
        upload = await receive_upload(
            content_type=request.headers.get("content-type"),
            content_length=request.headers.get("content-length"),
            chunks=request.stream(),
            tmp_dir=Path(settings.TMP_DIR),
            max_bytes=settings.MAX_UPLOAD_MB * 1024 * 1024,
        )
    except ApiError as exc:
        if exc.code is ErrorCode.FILE_TOO_LARGE:
            raise ApiError(exc.code, limit_message(exc.code, **limits)) from None
        raise

    try:
        if sniff_audio(upload.head) is None:
            raise ApiError(ErrorCode.UNSUPPORTED_FILE)
        try:
            probed = await services.probe(upload.path)
        except FFmpegError:
            raise ApiError(ErrorCode.UNSUPPORTED_FILE) from None
        duration = probed.duration_s
        if not (probed.has_audio and probed.allowed_container) or not duration or duration <= 0:
            raise ApiError(ErrorCode.UNSUPPORTED_FILE)
        if duration > settings.MAX_DURATION_S:
            code = ErrorCode.VIDEO_TOO_LONG
            raise ApiError(code, limit_message(code, **limits))

        async def stage(job_id: str) -> None:
            await asyncio.to_thread(_stage, upload.path, staged_upload_path(settings, job_id))

        return await ingest(
            services,
            source_key=f"up:{upload.sha256[:16]}",
            source="upload",
            title=sanitize_title(upload.filename, filename=True),
            duration_s=round(duration, 2),
            function=INGEST_UPLOAD,
            stage=stage,
        )
    finally:
        # Gone already if it was staged for the worker; otherwise it must not linger.
        await asyncio.to_thread(remove_path, upload.path)

"""JSON-lines logging for the api and the worker (ARCHITECTURE.md §7, ADR 0005 §16).

Each line has ``ts``, ``level``, ``logger`` and ``msg``, plus ``job_id`` / ``track_id`` /
``event`` / ``code`` when a record carries them (``logger.info(..., extra={...})``).
Only those allowlisted fields are ever emitted, so a stray ``extra`` can't leak data.

Never logged: secrets, cookies, client IPs, ``source_key``, titles, or raw URLs. Code in
this package keeps those out of messages; uvicorn's access log is rewritten below to drop
the client address and query string, and yt-dlp gets a silent logger (its messages embed
video URLs and titles).
"""

import json
import logging
import sys
import time
from typing import Any, TextIO

FIELDS = ("job_id", "track_id", "event", "code")

# Access-log lines for probes would drown everything else (liveness/readiness every few s).
_QUIET_PATHS = frozenset({"/api/health"})


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        doc: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for field in FIELDS:
            value = record.__dict__.get(field)
            if value is not None:
                doc[field] = str(value)
        if record.exc_info and record.exc_info[0] is not None:
            doc["exc_type"] = record.exc_info[0].__name__
            doc["exc"] = self.formatException(record.exc_info)
        return json.dumps(doc, ensure_ascii=False)


class _StdoutHandler(logging.StreamHandler[TextIO]):
    """Resolves ``sys.stdout`` at emit time (survives pytest's capture swapping it)."""

    def __init__(self) -> None:
        super().__init__(sys.stdout)

    @property
    def stream(self) -> TextIO:
        return sys.stdout

    @stream.setter
    def stream(self, value: TextIO) -> None:
        pass


class AccessLogFilter(logging.Filter):
    """Rewrite uvicorn access records to ``"GET /api/tracks/<id> 200"``.

    uvicorn's args are ``(client_addr, method, full_path, http_version, status_code)``;
    the client address and the query string are dropped. Health-probe lines are dropped.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) == 5:
            _client, method, full_path, _version, status = args
            path = str(full_path).split("?", 1)[0]
            if path in _QUIET_PATHS:
                return False
            record.msg = "%s %s %s"
            record.args = (method, path, status)
            return True
        # Unknown shape: never risk emitting a client address.
        record.msg = "request"
        record.args = None
        return True


def configure_logging(level: int = logging.INFO) -> None:
    """Route every logger (ours, uvicorn, arq) through one JSON stdout handler. Idempotent."""
    root = logging.getLogger()
    if not any(isinstance(h, _StdoutHandler) for h in root.handlers):
        handler = _StdoutHandler()
        handler.setFormatter(JsonFormatter())
        root.addHandler(handler)
    root.setLevel(level)

    for name in ("uvicorn", "uvicorn.error", "arq", "arq.worker", "arq.jobs", "arq.connections"):
        named = logging.getLogger(name)
        named.handlers.clear()
        named.propagate = True

    access = logging.getLogger("uvicorn.access")
    access.handlers.clear()
    access.propagate = True
    if not any(isinstance(f, AccessLogFilter) for f in access.filters):
        access.addFilter(AccessLogFilter())


class SilentYtDlpLogger:
    """yt-dlp ``logger`` param: swallow everything (messages embed URLs and titles)."""

    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        pass

    def error(self, msg: str) -> None:
        pass

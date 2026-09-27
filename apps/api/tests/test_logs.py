"""JSON logging (ADR 0005 §16): the format, and proof that sensitive data never reaches it."""

import io
import json
import logging
import sys
import uuid
from typing import Any

import fakeredis
import pytest
from fastapi.testclient import TestClient
from yt_dlp.utils import DownloadError

from pitchbend_live.audio import ffmpeg, key_detection
from pitchbend_live.clock import now_ts, ts_after
from pitchbend_live.db import Database
from pitchbend_live.db import repository as repo
from pitchbend_live.logs import (
    AccessLogFilter,
    JsonFormatter,
    SilentYtDlpLogger,
    _StdoutHandler,
    configure_logging,
)
from pitchbend_live.main import create_app
from pitchbend_live.services import Services
from pitchbend_live.settings import Settings, get_settings
from pitchbend_live.worker import youtube
from pitchbend_live.worker.context import WorkerDeps
from tests.conftest import FakeLimiter, FakeProbe, FakeQueue
from tests.worker_fakes import FakeFFmpeg, YtDlpScript, default_info, fake_youtubedl


def record(msg: str = "hello %s", args: Any = ("world",), **extra: Any) -> logging.LogRecord:
    rec = logging.LogRecord("pitchbend_live.test", logging.INFO, __file__, 1, msg, args, None)
    rec.__dict__.update(extra)
    return rec


def test_formatter_emits_allowlisted_fields_only() -> None:
    line = JsonFormatter().format(
        record(
            job_id="j1", track_id="t1", event="done", code="INTERNAL", url="https://x", title="T"
        )
    )
    doc = json.loads(line)
    assert set(doc) == {"ts", "level", "logger", "msg", "job_id", "track_id", "event", "code"}
    assert doc["msg"] == "hello world"
    assert doc["level"] == "INFO" and doc["logger"] == "pitchbend_live.test"
    assert doc["ts"].endswith("Z") and len(doc["ts"]) == 24
    assert "https://x" not in line and '"T"' not in line


def test_formatter_includes_exception_type() -> None:
    try:
        raise ValueError("bad")
    except ValueError:
        rec = record()
        rec.exc_info = sys.exc_info()
    doc = json.loads(JsonFormatter().format(rec))
    assert doc["exc_type"] == "ValueError"
    assert "Traceback" in doc["exc"]


def test_access_log_drops_client_address_and_query() -> None:
    rec = record(
        '%s - "%s %s HTTP/%s" %d',
        ("203.0.113.9:4444", "GET", "/api/tracks/abc?token=secret", "1.1", 200),
    )
    assert AccessLogFilter().filter(rec)
    assert rec.getMessage() == "GET /api/tracks/abc 200"


def test_access_log_drops_health_probes_and_unknown_shapes() -> None:
    probe = record('%s - "%s %s HTTP/%s" %d', ("10.0.0.1:1", "GET", "/api/health", "1.1", 200))
    assert AccessLogFilter().filter(probe) is False
    odd = record("%s did %s", ("203.0.113.9", "something"))
    assert AccessLogFilter().filter(odd)
    assert odd.getMessage() == "request"


def test_configure_logging_is_idempotent_and_routes_third_party_loggers() -> None:
    configure_logging()
    configure_logging()
    root = logging.getLogger()
    assert sum(isinstance(h, _StdoutHandler) for h in root.handlers) == 1
    for name in ("uvicorn.error", "uvicorn.access", "arq.worker"):
        assert logging.getLogger(name).handlers == []
        assert logging.getLogger(name).propagate
    access_filters = logging.getLogger("uvicorn.access").filters
    assert sum(isinstance(f, AccessLogFilter) for f in access_filters) == 1


def test_stdout_handler_follows_sys_stdout(monkeypatch: pytest.MonkeyPatch) -> None:
    handler = _StdoutHandler()
    buffer = io.StringIO()
    monkeypatch.setattr(sys, "stdout", buffer)
    handler.stream = io.StringIO()  # ignored: always the current sys.stdout
    handler.setFormatter(JsonFormatter())
    handler.emit(record())
    assert json.loads(buffer.getvalue())["msg"] == "hello world"


def test_silent_ytdlp_logger() -> None:
    silent = SilentYtDlpLogger()
    for method in (silent.debug, silent.info, silent.warning, silent.error):
        assert method("https://www.youtube.com/watch?v=dQw4w9WgXcQ Secret Title") is None


# --- the proof: none of these ever appear in any log line ------------------------------

SECRET_TOKEN = "duckdns-" + uuid.uuid4().hex
SECRET_DSN = "https://" + uuid.uuid4().hex + "@sentry.example/1"
CLIENT_IP = "203.0.113.77"
VIDEO_ID = "Zx9_Secret1"
RAW_URL = f"https://www.youtube.com/watch?v={VIDEO_ID}&si=TRACKINGsi123"
UPLOAD_TITLE = "Confidential Demo Take"
YT_TITLE = "Private Rehearsal Title"


@pytest.fixture
def all_logs(caplog: pytest.LogCaptureFixture) -> pytest.LogCaptureFixture:
    caplog.set_level(logging.DEBUG)
    return caplog


def rendered(caplog: pytest.LogCaptureFixture) -> str:
    formatter = JsonFormatter()
    return "\n".join(formatter.format(r) for r in caplog.records)


@pytest.mark.anyio
async def test_sensitive_values_are_never_logged(
    all_logs: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
    redis_server: fakeredis.FakeServer,
) -> None:
    monkeypatch.setenv("DUCKDNS_TOKEN", SECRET_TOKEN)
    monkeypatch.setenv("SENTRY_DSN", SECRET_DSN)
    get_settings.cache_clear()
    settings: Settings = get_settings()
    limiter = FakeLimiter(remaining=3)
    services = Services(
        settings=settings,
        db=Database(settings.DB_PATH),
        redis=fakeredis.FakeAsyncRedis(server=redis_server),
        queue=FakeQueue(),
        limiter=limiter,
        probe=FakeProbe(),
    )

    # API: a YouTube job, an upload, a rejected URL, and a rate-limited request.
    with TestClient(create_app(services), client=(CLIENT_IP, 5555)) as client:
        job = client.post("/api/jobs", json={"url": RAW_URL}).json()
        client.post("/api/jobs", json={"url": "https://evil.example/?u=" + RAW_URL})
        mp3 = b"ID3\x04" + b"\x00" * 500
        client.post("/api/uploads", files={"file": (f"{UPLOAD_TITLE}.mp3", mp3, "audio/mpeg")})
        client.post("/api/jobs", json={"url": RAW_URL})
        limited = client.post("/api/jobs", json={"url": RAW_URL})
        assert limited.status_code == 429
    assert limiter.clients[0] == CLIENT_IP

    # Worker: a successful ingest (with a key failure) and a blocked one.
    script = YtDlpScript(info=default_info(id=VIDEO_ID, title=YT_TITLE))
    monkeypatch.setattr(youtube, "YoutubeDL", fake_youtubedl(script))
    fake = FakeFFmpeg()
    monkeypatch.setattr(ffmpeg, "probe", fake.probe)
    monkeypatch.setattr(ffmpeg, "normalize_to_m4a", fake.normalize)

    def failing_detect(path: object) -> key_detection.KeyResult:
        raise key_detection.KeyDetectionError("no tonal content")  # logged with traceback

    monkeypatch.setattr(key_detection, "detect_key", failing_detect)
    ctx = {"deps": WorkerDeps(settings, services.db, fakeredis.FakeAsyncRedis(server=redis_server))}
    await youtube.fetch_youtube(ctx, job["job_id"])

    now = now_ts()
    blocked = services.db.call(
        repo.find_or_create_ingest,
        source_key="yt:" + VIDEO_ID[::-1],
        source="youtube",
        title=None,
        duration_s=None,
        now=now,
        ttl_hours=24,
        stale_before=ts_after(now, seconds=-repo.STALE_JOB_S),
        new_track_id=str(uuid.uuid4()),
        new_job_id=str(uuid.uuid4()),
    )
    script.extract_error = DownloadError(f"ERROR: [youtube] {VIDEO_ID}: {RAW_URL} {YT_TITLE} bot")
    await youtube.fetch_youtube(ctx, blocked.job_id)

    logs = rendered(all_logs)
    assert '"event": "job_created"' in logs and '"event": "done"' in logs  # logging happened
    assert '"code": "KEY_DETECTION_FAILED"' in logs
    for forbidden in (
        SECRET_TOKEN,
        SECRET_DSN,
        CLIENT_IP,
        VIDEO_ID,
        VIDEO_ID[::-1],
        "TRACKINGsi123",
        "youtube.com/watch",
        "yt:",
        "up:",
        UPLOAD_TITLE,
        YT_TITLE,
    ):
        assert forbidden not in logs, forbidden

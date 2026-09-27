"""POST /api/uploads: streaming intake, limits, validation, dedup (§6.4, ADR 0005 §11-12)."""

import hashlib
import os
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import fakeredis
import pytest
from fastapi.testclient import TestClient

from pitchbend_live.audio.ffmpeg import FFmpegError, ProbeResult
from pitchbend_live.db import Database
from pitchbend_live.db import repository as repo
from pitchbend_live.errors import ApiError, ErrorCode
from pitchbend_live.main import create_app
from pitchbend_live.routes.uploads import MULTIPART_ALLOWANCE, receive_upload
from pitchbend_live.services import Services
from pitchbend_live.settings import Settings
from tests.conftest import FakeLimiter, FakeProbe, FakeQueue

MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 2000
BOUNDARY = "----pitchbendliveboundary"


def body(
    parts: list[tuple[str, str | None, bytes]], *, boundary: str = BOUNDARY, close: bool = True
) -> bytes:
    out = b""
    for name, filename, data in parts:
        disposition = f'form-data; name="{name}"'
        if filename is not None:
            disposition += f'; filename="{filename}"'
        out += f"--{boundary}\r\nContent-Disposition: {disposition}\r\n".encode()
        out += b"Content-Type: application/octet-stream\r\n\r\n" + data + b"\r\n"
    if close:
        out += f"--{boundary}--\r\n".encode()
    return out


CTYPE = {"content-type": f"multipart/form-data; boundary={BOUNDARY}"}


def tmp_entries(settings: Settings) -> list[str]:
    return sorted(os.listdir(settings.TMP_DIR))


def upload(
    client: TestClient, data: bytes = MP3, filename: str = "My Song.mp3"
) -> tuple[int, dict]:  # type: ignore[type-arg]
    response = client.post("/api/uploads", files={"file": (filename, data, "audio/mpeg")})
    return response.status_code, response.json()


# --- happy path, dedup, titles --------------------------------------------------------------


def test_upload_is_staged_and_enqueued(
    client: TestClient, services: Services, queue: FakeQueue, probe: FakeProbe
) -> None:
    status, created = upload(client)
    assert status == 202
    assert created["status"] == "queued"
    assert queue.calls == [("ingest_upload", created["job_id"])]

    staged = Path(services.settings.TMP_DIR) / created["job_id"] / "upload"
    assert staged.read_bytes() == MP3
    assert tmp_entries(services.settings) == [created["job_id"]]  # no .part left behind
    assert probe.paths and probe.paths[0].name.startswith(".upload-")

    track = services.db.call(repo.get_track, created["track_id"])
    assert track is not None
    assert track.source_key == "up:" + hashlib.sha256(MP3).hexdigest()[:16]
    assert (track.source, track.title, track.duration_s, track.status) == (
        "upload",
        "My Song",
        180.0,
        "queued",
    )


def test_same_bytes_dedup_join_then_hit(
    client: TestClient, services: Services, queue: FakeQueue
) -> None:
    _, first = upload(client)
    status, again = upload(client, filename="renamed.wav")
    assert status == 202 and again == first
    assert len(queue.calls) == 1
    assert tmp_entries(services.settings) == [first["job_id"]]

    services.db.call(repo.start_job, first["job_id"])
    services.db.call(repo.mark_track_ready, first["track_id"], "u.m4a", 180.0, "My Song")
    services.db.call(repo.finish_job, first["job_id"])
    status, hit = upload(client)
    assert status == 200
    assert hit == {**first, "status": "done"}
    assert len(queue.calls) == 1


def test_different_bytes_are_different_tracks(client: TestClient) -> None:
    _, a = upload(client, MP3)
    _, b = upload(client, MP3 + b"\x01")
    assert a["track_id"] != b["track_id"]


@pytest.mark.parametrize(
    ("filename", "title"),
    [
        ("../../etc/evil\x07name.mp3", "evil name"),
        ("C:\\Users\\me\\Desktop\\Take 5 .flac", "Take 5"),
        ("x" * 300 + ".mp3", "x" * 120),
        (".mp3", ".mp3"),
    ],
)
def test_title_comes_from_sanitized_filename(
    client: TestClient, services: Services, filename: str, title: str
) -> None:
    payload = body([("file", filename, MP3 + filename.encode())])
    response = client.post("/api/uploads", content=payload, headers=CTYPE)
    assert response.status_code == 202
    track = services.db.call(repo.get_track, response.json()["track_id"])
    assert track is not None and track.title == title


def test_missing_filename_is_untitled(client: TestClient, services: Services) -> None:
    response = client.post("/api/uploads", content=body([("file", None, MP3)]), headers=CTYPE)
    assert response.status_code == 202
    track = services.db.call(repo.get_track, response.json()["track_id"])
    assert track is not None and track.title == "Untitled"


def test_extra_fields_are_ignored_and_first_file_wins(
    client: TestClient, services: Services
) -> None:
    payload = body([("note", None, b"hello"), ("file", "a.mp3", MP3), ("file", "b.mp3", b"OTHER")])
    response = client.post("/api/uploads", content=payload, headers=CTYPE)
    assert response.status_code == 202
    staged = Path(services.settings.TMP_DIR) / response.json()["job_id"] / "upload"
    assert staged.read_bytes() == MP3


# --- 413 ------------------------------------------------------------------------------------


@pytest.fixture
def small(
    settings: Settings, redis_server: fakeredis.FakeServer, queue: FakeQueue, probe: FakeProbe
) -> Iterator[tuple[TestClient, Settings]]:
    """MAX_UPLOAD_MB=1 (1 MiB)."""
    limited = settings.model_copy(update={"MAX_UPLOAD_MB": 1})
    services = Services(
        settings=limited,
        db=Database(limited.DB_PATH),
        redis=fakeredis.FakeAsyncRedis(server=redis_server),
        queue=queue,
        limiter=FakeLimiter(),
        probe=probe,
    )
    with TestClient(create_app(services)) as client:
        yield client, limited


def test_413_by_content_length(small: tuple[TestClient, Settings], queue: FakeQueue) -> None:
    client, settings = small
    big = MP3 + b"\x00" * (1024 * 1024)
    response = client.post("/api/uploads", files={"file": ("big.mp3", big, "audio/mpeg")})
    assert response.status_code == 413
    error = response.json()["error"]
    assert error["code"] == "FILE_TOO_LARGE"
    assert "1 MB" in error["message"]
    assert tmp_entries(settings) == []
    assert queue.calls == []


def test_413_while_streaming_without_content_length(small: tuple[TestClient, Settings]) -> None:
    client, settings = small
    payload = body([("file", "big.mp3", MP3 + b"\x00" * (1024 * 1024))])

    def chunks() -> Iterator[bytes]:
        for i in range(0, len(payload), 65536):
            yield payload[i : i + 65536]

    response = client.post("/api/uploads", content=chunks(), headers=CTYPE)
    assert "content-length" not in response.request.headers
    assert response.status_code == 413
    assert tmp_entries(settings) == []


def test_exactly_at_the_limit_is_accepted(small: tuple[TestClient, Settings]) -> None:
    client, _ = small
    exact = MP3 + b"\x00" * (1024 * 1024 - len(MP3))
    status, _body = upload(client, exact)
    assert status == 202


def test_rate_limit_is_checked_before_the_body(
    client: TestClient, services: Services, limiter: FakeLimiter, probe: FakeProbe
) -> None:
    limiter.remaining = 0
    headers = {**CTYPE, "content-length": str(10**9)}
    response = client.post("/api/uploads", content=body([("file", "a.mp3", MP3)]), headers=headers)
    assert response.status_code == 429  # not 413: the body was never looked at
    assert response.headers["retry-after"] == "42"
    assert response.json()["error"]["retry_after_s"] == 42
    assert probe.paths == []
    assert tmp_entries(services.settings) == []


# --- 400 / 422 ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("content", "headers"),
    [
        (b'{"file": "x"}', {"content-type": "application/json"}),
        (body([("file", "a.mp3", MP3)]), {"content-type": "multipart/form-data"}),  # no boundary
        (body([("file", "a.mp3", MP3)]), {}),
        (body([("other", "a.mp3", MP3)]), CTYPE),  # no "file" field
        (body([("file", "a.mp3", b"")]), CTYPE),  # empty file
        (body([("file", "a.mp3", MP3)], close=False), CTYPE),  # truncated
        (b"garbage without any boundary", CTYPE),
        (body([("file", "a.mp3", MP3)]), {**CTYPE, "content-length": "abc"}),
        (
            body([("file", "a.mp3", MP3)], boundary="x" * 300),
            {"content-type": "multipart/form-data; boundary=" + "x" * 300},
        ),
    ],
    ids=[
        "json",
        "no-boundary",
        "no-content-type",
        "no-file-field",
        "empty-file",
        "truncated",
        "garbage",
        "bad-content-length",
        "boundary-too-long",
    ],
)
def test_malformed_uploads_are_unsupported_file(
    client: TestClient, services: Services, content: bytes, headers: dict[str, str]
) -> None:
    response = client.post("/api/uploads", content=content, headers=headers)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "UNSUPPORTED_FILE"
    assert tmp_entries(services.settings) == []


@pytest.mark.parametrize(
    "data",
    [
        b"just some text, definitely not audio" * 10,
        b"\x89PNG\r\n\x1a\n" + b"\x00" * 100,
        b"%PDF-1.7" + b"\x00" * 100,
        b"\x1aE\xdf\xa3" + b"\x00" * 100,  # webm/matroska: not an allowed container
    ],
)
def test_non_audio_magic_bytes_are_rejected(
    client: TestClient, services: Services, probe: FakeProbe, data: bytes
) -> None:
    status, error = upload(client, data, filename="song.mp3")  # the extension doesn't count
    assert status == 400 and error["error"]["code"] == "UNSUPPORTED_FILE"
    assert probe.paths == []  # sniffing runs before ffprobe
    assert tmp_entries(services.settings) == []


@pytest.mark.parametrize(
    "result",
    [
        ProbeResult(frozenset({"mp3"}), 100.0, (), False),  # no audio stream
        ProbeResult(frozenset({"matroska", "webm"}), 100.0, ("opus",), False),
        ProbeResult(frozenset({"mp3"}), None, ("mp3",), False),  # unknown duration
        ProbeResult(frozenset({"mp3"}), 0.0, ("mp3",), False),
    ],
)
def test_ffprobe_rejections(
    client: TestClient, services: Services, probe: FakeProbe, result: ProbeResult
) -> None:
    probe.result = result
    status, error = upload(client)
    assert status == 400 and error["error"]["code"] == "UNSUPPORTED_FILE"
    assert tmp_entries(services.settings) == []


def test_ffprobe_failure_is_unsupported(
    client: TestClient, services: Services, probe: FakeProbe
) -> None:
    probe.error = FFmpegError("ffprobe exited with 1")
    status, error = upload(client)
    assert status == 400 and error["error"]["code"] == "UNSUPPORTED_FILE"
    assert tmp_entries(services.settings) == []


def test_too_long_is_422(client: TestClient, services: Services, probe: FakeProbe) -> None:
    probe.result = ProbeResult(frozenset({"mp3"}), 720.5, ("mp3",), False)
    status, error = upload(client)
    assert status == 422
    assert error["error"]["code"] == "VIDEO_TOO_LONG"
    assert "12 minutes" in error["error"]["message"]
    assert tmp_entries(services.settings) == []


def test_exactly_max_duration_is_accepted(client: TestClient, probe: FakeProbe) -> None:
    probe.result = ProbeResult(frozenset({"mp3"}), 720.0, ("mp3",), False)
    assert upload(client)[0] == 202


def test_enqueue_failure_cleans_staging(
    client: TestClient, services: Services, queue: FakeQueue
) -> None:
    queue.fail = True
    status, error = upload(client)
    assert status == 500 and error["error"]["code"] == "INTERNAL"
    assert tmp_entries(services.settings) == []


def test_unexpected_probe_crash_is_internal_and_cleans_up(
    services: Services, probe: FakeProbe
) -> None:
    probe.error = OSError("ffprobe missing")
    with TestClient(create_app(services), raise_server_exceptions=False) as client:
        status, error = upload(client)
    assert status == 500 and error["error"]["code"] == "INTERNAL"
    assert tmp_entries(services.settings) == []


# --- the streaming receiver itself ------------------------------------------------------------


class Chunks:
    """An async chunk source that records how much of the body was consumed."""

    def __init__(self, payload: bytes, size: int = 1024) -> None:
        self.parts = [payload[i : i + size] for i in range(0, len(payload), size)]
        self.consumed = 0

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for part in self.parts:
            self.consumed += 1
            yield part


pytestmark = pytest.mark.anyio


async def receive(chunks: Chunks, tmp_path: Path, max_bytes: int, **kw: str | None) -> object:
    return await receive_upload(
        content_type=kw.get("content_type", CTYPE["content-type"]),
        content_length=kw.get("content_length"),
        chunks=chunks.__aiter__(),
        tmp_dir=tmp_path,
        max_bytes=max_bytes,
    )


async def test_receiver_hashes_and_writes_while_streaming(tmp_path: Path) -> None:
    data = MP3 * 5
    result = await receive(Chunks(body([("file", "s.mp3", data)]), 333), tmp_path, 10**6)
    assert result.path.read_bytes() == data  # type: ignore[attr-defined]
    assert result.size == len(data)  # type: ignore[attr-defined]
    assert result.sha256 == hashlib.sha256(data).hexdigest()  # type: ignore[attr-defined]
    assert result.head == data[:16]  # type: ignore[attr-defined]
    assert result.filename == "s.mp3"  # type: ignore[attr-defined]


async def test_receiver_aborts_at_the_limit_without_reading_the_rest(tmp_path: Path) -> None:
    chunks = Chunks(body([("file", "big.mp3", b"\x00" * 200_000)]), 1024)
    with pytest.raises(ApiError) as caught:
        await receive(chunks, tmp_path, 50_000)
    assert caught.value.code is ErrorCode.FILE_TOO_LARGE
    assert chunks.consumed < len(chunks.parts) / 2
    assert os.listdir(tmp_path) == []


async def test_receiver_rejects_oversized_declared_length(tmp_path: Path) -> None:
    chunks = Chunks(body([("file", "a.mp3", MP3)]))
    with pytest.raises(ApiError) as caught:
        await receive(chunks, tmp_path, 1000, content_length=str(1000 + MULTIPART_ALLOWANCE + 1))
    assert caught.value.code is ErrorCode.FILE_TOO_LARGE
    assert chunks.consumed == 0


async def test_receiver_caps_non_file_fields(tmp_path: Path) -> None:
    chunks = Chunks(body([("junk", None, b"x" * (MULTIPART_ALLOWANCE + 1)), ("file", "a", MP3)]))
    with pytest.raises(ApiError) as caught:
        await receive(chunks, tmp_path, 10**7)
    assert caught.value.code is ErrorCode.FILE_TOO_LARGE
    assert os.listdir(tmp_path) == []


async def test_receiver_caps_total_body_without_content_length(tmp_path: Path) -> None:
    # Many small non-file parts, each under the per-field cap, still can't exceed the body cap.
    parts = [("f", None, b"y" * 1000) for _ in range(200)]
    with pytest.raises(ApiError) as caught:
        await receive(Chunks(body(parts)), tmp_path, 1000)
    assert caught.value.code is ErrorCode.FILE_TOO_LARGE


async def test_receiver_client_disconnect(tmp_path: Path) -> None:
    from starlette.requests import ClientDisconnect

    async def dropping() -> AsyncIterator[bytes]:
        yield body([("file", "a.mp3", MP3)])[:500]
        raise ClientDisconnect

    with pytest.raises(ApiError) as caught:
        await receive_upload(
            content_type=CTYPE["content-type"],
            content_length=None,
            chunks=dropping(),
            tmp_dir=tmp_path,
            max_bytes=10**6,
        )
    assert caught.value.code is ErrorCode.UNSUPPORTED_FILE
    assert os.listdir(tmp_path) == []

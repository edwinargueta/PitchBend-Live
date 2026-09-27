"""Upload -> worker with real ffprobe/ffmpeg (container only); detect_key is faked."""

import os
from pathlib import Path
from typing import Any

import fakeredis
import pytest
from fastapi.testclient import TestClient

from keyshift.audio import ffmpeg, key_detection
from keyshift.db import Database
from keyshift.db import repository as repo
from keyshift.main import create_app
from keyshift.services import Services
from keyshift.settings import Settings
from keyshift.worker.context import WorkerDeps
from keyshift.worker.upload import ingest_upload
from tests.conftest import FakeLimiter, FakeQueue, requires_ffmpeg
from tests.test_audio_ffmpeg import FORMATS, make_fixture
from tests.worker_fakes import KEY_RESULT

pytestmark = [pytest.mark.anyio, requires_ffmpeg]


@pytest.fixture
def real_services(
    settings: Settings, redis_server: fakeredis.FakeServer, queue: FakeQueue
) -> Services:
    return Services(
        settings=settings,
        db=Database(settings.DB_PATH),
        redis=fakeredis.FakeAsyncRedis(server=redis_server),
        queue=queue,
        limiter=FakeLimiter(),
        probe=ffmpeg.probe,
    )


@pytest.mark.parametrize(("ext", "extra", "family", "fmt"), FORMATS)
async def test_upload_then_ingest_with_real_ffmpeg(
    tmp_path: Path,
    real_services: Services,
    queue: FakeQueue,
    redis_server: fakeredis.FakeServer,
    monkeypatch: pytest.MonkeyPatch,
    ext: str,
    extra: list[str],
    family: str,
    fmt: str,
) -> None:
    monkeypatch.setattr(key_detection, "detect_key", lambda path: KEY_RESULT)
    fixture = await make_fixture(tmp_path / f"My Tone.{ext}", extra, seconds=2.0)
    settings = real_services.settings

    with TestClient(create_app(real_services)) as client:
        response = client.post(
            "/api/uploads", files={"file": (fixture.name, fixture.read_bytes(), "audio/x-test")}
        )
    assert response.status_code == 202, response.text
    created = response.json()
    assert queue.calls == [("ingest_upload", created["job_id"])]

    ctx: dict[str, Any] = {
        "deps": WorkerDeps(
            settings, real_services.db, fakeredis.FakeAsyncRedis(server=redis_server)
        )
    }
    await ingest_upload(ctx, created["job_id"])

    track = real_services.db.call(repo.get_track, created["track_id"])
    assert track is not None and track.status == "ready", track
    assert track.title == "My Tone"
    assert track.duration_s is not None and abs(track.duration_s - 2.0) < 0.15
    media = Path(settings.MEDIA_DIR) / str(track.media_file)
    final = await ffmpeg.probe(media)
    assert final.is_playback_ready  # AAC in m4a, whatever went in (D8)
    assert os.listdir(settings.TMP_DIR) == []


async def test_real_too_long_upload_is_422(
    tmp_path: Path, real_services: Services, settings: Settings
) -> None:
    fixture = await make_fixture(tmp_path / "long.mp3", ["-c:a", "libmp3lame"], seconds=3.0)
    real_services.settings = settings.model_copy(update={"MAX_DURATION_S": 2})
    with TestClient(create_app(real_services)) as client:
        response = client.post(
            "/api/uploads", files={"file": ("long.mp3", fixture.read_bytes(), "audio/mpeg")}
        )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VIDEO_TOO_LONG"
    assert os.listdir(settings.TMP_DIR) == []


async def test_real_disguised_file_is_rejected(tmp_path: Path, real_services: Services) -> None:
    fake = tmp_path / "song.mp3"
    fake.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"not really audio" * 100)
    with TestClient(create_app(real_services)) as client:
        response = client.post(
            "/api/uploads", files={"file": ("song.mp3", fake.read_bytes(), "audio/mpeg")}
        )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "UNSUPPORTED_FILE"

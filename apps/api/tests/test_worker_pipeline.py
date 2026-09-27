"""Worker ingest pipelines end to end with fake yt-dlp / ffmpeg / detect_key (§10 A3-A5)."""

import asyncio
import os
import stat
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import fakeredis
import pytest
from yt_dlp.utils import DownloadError, ExtractorError, GeoRestrictedError

from pitchbend_live.audio import ffmpeg, key_detection
from pitchbend_live.clock import now_ts, ts_after
from pitchbend_live.db import Database
from pitchbend_live.db import repository as repo
from pitchbend_live.db.connection import connect
from pitchbend_live.errors import ErrorCode
from pitchbend_live.settings import Settings
from pitchbend_live.storage import staged_upload_path
from pitchbend_live.worker import pipeline, upload, youtube
from pitchbend_live.worker.context import WorkerDeps
from tests.worker_fakes import (
    KEY_RESULT,
    VIDEO_ID,
    FakeFFmpeg,
    YtDlpScript,
    default_info,
    drain,
    fake_youtubedl,
    state_of,
)

pytestmark = pytest.mark.anyio


@pytest.fixture
def fake_ffmpeg(monkeypatch: pytest.MonkeyPatch) -> FakeFFmpeg:
    fake = FakeFFmpeg()
    monkeypatch.setattr(ffmpeg, "probe", fake.probe)
    monkeypatch.setattr(ffmpeg, "normalize_to_m4a", fake.normalize)
    return fake


@pytest.fixture
def script(monkeypatch: pytest.MonkeyPatch) -> YtDlpScript:
    s = YtDlpScript()
    monkeypatch.setattr(youtube, "YoutubeDL", fake_youtubedl(s))
    return s


@pytest.fixture
def detect_calls(
    monkeypatch: pytest.MonkeyPatch, sync_redis: fakeredis.FakeRedis
) -> list[dict[str, Any]]:
    """Fake detect_key; records the job_state it saw, to prove audio_ready came first."""
    calls: list[dict[str, Any]] = []

    def fake_detect(path: Path) -> key_detection.KeyResult:
        job_states = [
            state_of(sync_redis, k.decode().split(":", 1)[1])
            for k in sync_redis.keys("job_state:*")
        ]
        calls.append({"path": path, "exists": path.exists(), "states": job_states})
        return KEY_RESULT

    monkeypatch.setattr(key_detection, "detect_key", fake_detect)
    return calls


@pytest.fixture
def ctx(settings: Settings, db: Database, aredis: fakeredis.FakeAsyncRedis) -> dict[str, Any]:
    return {"deps": WorkerDeps(settings=settings, db=db, redis=aredis)}


@pytest.fixture
async def pubsub(aredis: fakeredis.FakeAsyncRedis) -> AsyncIterator[Any]:
    ps = aredis.pubsub()
    await ps.psubscribe("job:*")
    yield ps
    await ps.aclose()


def new_job(db: Database, source_key: str = f"yt:{VIDEO_ID}", **kw: Any) -> repo.DedupResult:
    now = now_ts()
    return db.call(
        repo.find_or_create_ingest,
        source_key=source_key,
        source=kw.get("source", "youtube"),
        title=kw.get("title"),
        duration_s=None,
        now=now,
        ttl_hours=24,
        stale_before=ts_after(now, seconds=-repo.STALE_JOB_S),
        new_track_id=str(uuid.uuid4()),
        new_job_id=str(uuid.uuid4()),
    )


def names(recorded: list[tuple[str, dict[str, Any]]]) -> list[str]:
    return [
        f"{e}:{d['stage']}" if e == "progress" else (f"{e}:{d['code']}" if e == "error" else e)
        for e, d in recorded
    ]


# --- YouTube happy path ---------------------------------------------------------------


async def test_fetch_youtube_end_to_end(
    ctx: dict[str, Any],
    db: Database,
    settings: Settings,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    detect_calls: list[dict[str, Any]],
    pubsub: Any,
) -> None:
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    recorded = await drain(pubsub)

    assert names(recorded) == [
        "progress:fetching",
        "progress:fetching",
        "progress:fetching",
        "progress:fetching",
        "progress:processing",
        "audio_ready",
        "progress:analyzing",
        "key_ready",
        "done",
    ]
    pcts = [d["pct"] for e, d in recorded if e == "progress" and d["stage"] == "fetching"]
    assert pcts == [None, 0, 50, 100]  # throttled: 1 % and "unknown" updates were dropped

    audio_ready = dict(recorded)["audio_ready"]
    track = db.call(repo.get_track, job.track_id)
    assert track is not None
    assert audio_ready == {
        "track_id": job.track_id,
        "audio_url": f"/media/{track.media_file}",
        "duration_s": 213.04,
        "title": "Never Gonna Give You Up",
    }
    assert dict(recorded)["key_ready"] == KEY_RESULT.to_dict()

    # yt-dlp saw only the rebuilt URL, with the verified options.
    ydl = script.instances[0]
    assert ydl.urls == [f"https://www.youtube.com/watch?v={VIDEO_ID}"]
    params = ydl.params
    assert params["format"] == "bestaudio[ext=m4a]/bestaudio"
    assert params["noplaylist"] is True
    assert "deno" in params["js_runtimes"]
    assert params["outtmpl"] == {"default": "source.%(ext)s"}
    assert params["quiet"] and params["no_warnings"] and params["noprogress"]
    assert "cookiefile" not in params and "cookiesfrombrowser" not in params
    assert ydl.closed

    # SQLite, files, and cleanup of the staging dir.
    assert (track.status, track.title, track.duration_s, track.error_code) == (
        "ready",
        "Never Gonna Give You Up",
        213.04,
        None,
    )
    assert track.key() == KEY_RESULT.to_dict()
    assert db.call(repo.get_job, job.job_id).status == "done"  # type: ignore[union-attr]
    media = Path(settings.MEDIA_DIR) / str(track.media_file)
    assert media.read_bytes() == b"fake downloaded audio"
    assert stat.S_IMODE(media.stat().st_mode) == 0o644
    assert str(track.media_file).endswith(".m4a")
    uuid.UUID(str(track.media_file)[:-4], version=4)
    assert VIDEO_ID not in str(track.media_file)
    assert not (Path(settings.TMP_DIR) / job.job_id).exists()

    # audio_ready was published before key detection started (§6.5).
    assert len(detect_calls) == 1
    assert detect_calls[0]["exists"]
    seen = detect_calls[0]["states"][0]
    assert seen["audio_ready"] is not None and seen["key_ready"] is None


async def test_fetch_youtube_uses_glob_when_filepath_unreported(
    ctx: dict[str, Any],
    db: Database,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    detect_calls: list[dict[str, Any]],
) -> None:
    script.report_filepath = False
    script.download_ext = "webm"
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert db.call(repo.get_track, job.track_id).status == "ready"  # type: ignore[union-attr]
    assert fake_ffmpeg.normalized[0][0].name == "source.webm"


async def test_missing_download_is_internal(
    ctx: dict[str, Any],
    db: Database,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    pubsub: Any,
) -> None:
    script.write_file = False
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert names(await drain(pubsub))[-1] == "error:INTERNAL"


# --- YouTube failures -------------------------------------------------------------------


BOT = "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you" + chr(0x2019) + "re not a bot."


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (DownloadError(BOT), "SOURCE_BLOCKED"),
        (DownloadError("ERROR: HTTP Error 429: Too Many Requests"), "SOURCE_BLOCKED"),
        (
            DownloadError(
                "ERROR: [youtube] x: Video unavailable. This content isn't available,"
                " try again later. rate-limited"
            ),
            "SOURCE_BLOCKED",
        ),
        (
            DownloadError(
                "ERROR: [youtube] dQw4w9WgXcQ: Private video. Sign in if you've been granted access"
            ),
            "SOURCE_UNAVAILABLE",
        ),
        (DownloadError("ERROR: [youtube] dQw4w9WgXcQ: Video unavailable"), "SOURCE_UNAVAILABLE"),
        (
            DownloadError("ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age"),
            "SOURCE_UNAVAILABLE",
        ),
        (DownloadError("ERROR: This video has been removed by the uploader"), "SOURCE_UNAVAILABLE"),
        (DownloadError("ERROR: This live event will begin in 3 hours."), "LIVESTREAM"),
        (DownloadError("ERROR: something nobody anticipated"), "SOURCE_BLOCKED"),
        (GeoRestrictedError("blocked in your region"), "SOURCE_UNAVAILABLE"),
        (ExtractorError("Unable to download webpage", expected=True), "SOURCE_BLOCKED"),
    ],
)
async def test_extract_errors_map_to_codes(
    ctx: dict[str, Any],
    db: Database,
    settings: Settings,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    pubsub: Any,
    error: BaseException,
    code: str,
) -> None:
    script.extract_error = error
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    recorded = await drain(pubsub)
    assert names(recorded) == ["progress:fetching", f"error:{code}"]
    assert recorded[-1][1]["message"]
    track = db.call(repo.get_track, job.track_id)
    assert track is not None and (track.status, track.error_code) == ("error", code)
    assert db.call(repo.get_job, job.job_id).status == "error"  # type: ignore[union-attr]
    assert not (Path(settings.TMP_DIR) / job.job_id).exists()
    assert os.listdir(settings.MEDIA_DIR) == []


def test_geo_restriction_wrapped_in_download_error() -> None:
    try:
        raise GeoRestrictedError("nope")
    except GeoRestrictedError:
        import sys

        wrapped = DownloadError("ERROR: blocked", sys.exc_info())
    assert youtube.map_ytdlp_error(wrapped, VIDEO_ID) is ErrorCode.SOURCE_UNAVAILABLE


def test_video_id_is_ignored_when_matching() -> None:
    # An id containing "429" must not look like an HTTP 429.
    assert (
        youtube.map_ytdlp_error(
            DownloadError("[youtube] ab429cdefgh: Private video"), "ab429cdefgh"
        )
        is ErrorCode.SOURCE_UNAVAILABLE
    )


@pytest.mark.parametrize(
    ("info", "code"),
    [
        (default_info(is_live=True), "LIVESTREAM"),
        (default_info(live_status="is_live"), "LIVESTREAM"),
        (default_info(live_status="is_upcoming"), "LIVESTREAM"),
        (default_info(live_status="post_live"), "LIVESTREAM"),
        (default_info(duration=721), "VIDEO_TOO_LONG"),
        (default_info(_type="playlist"), "SOURCE_UNAVAILABLE"),
    ],
)
async def test_probe_rejects_before_download(
    ctx: dict[str, Any],
    db: Database,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    pubsub: Any,
    info: dict[str, Any],
    code: str,
) -> None:
    script.info = info
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert names(await drain(pubsub))[-1] == f"error:{code}"
    assert script.instances[0].processed is None  # never downloaded


async def test_download_error_is_mapped(
    ctx: dict[str, Any],
    db: Database,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    pubsub: Any,
) -> None:
    script.download_error = DownloadError(
        "ERROR: unable to download video data: HTTP Error 403: Forbidden"
    )
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    track = db.call(repo.get_track, job.track_id)
    assert track is not None and track.error_code == "SOURCE_BLOCKED"
    # The probed title/duration were stored before the download started.
    assert (track.title, track.duration_s) == ("Never Gonna Give You Up", 213.0)


async def test_duration_unknown_until_download_then_too_long(
    ctx: dict[str, Any],
    db: Database,
    settings: Settings,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    pubsub: Any,
) -> None:
    script.info = default_info(duration=None)
    fake_ffmpeg.final_duration = 900.0
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert names(await drain(pubsub))[-1] == "error:VIDEO_TOO_LONG"
    assert os.listdir(settings.MEDIA_DIR) == []


@pytest.mark.parametrize("duration", [None, 0.0])
async def test_unreadable_output_is_internal_for_youtube(
    ctx: dict[str, Any],
    db: Database,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    pubsub: Any,
    duration: float | None,
) -> None:
    fake_ffmpeg.final_duration = duration
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert names(await drain(pubsub))[-1] == "error:INTERNAL"


async def test_ffmpeg_failure_is_internal_for_youtube(
    ctx: dict[str, Any],
    db: Database,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    pubsub: Any,
) -> None:
    fake_ffmpeg.normalize_error = ffmpeg.FFmpegError("ffmpeg exited with 1")
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert names(await drain(pubsub))[-1] == "error:INTERNAL"


async def test_source_without_audio_is_rejected(
    ctx: dict[str, Any],
    db: Database,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    pubsub: Any,
) -> None:
    fake_ffmpeg.source = ffmpeg.ProbeResult(frozenset({"mp4"}), 10.0, (), True)
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert names(await drain(pubsub))[-1] == "error:INTERNAL"


async def test_unexpected_crash_is_internal(
    ctx: dict[str, Any],
    db: Database,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    pubsub: Any,
) -> None:
    fake_ffmpeg.probe_error = RuntimeError("boom")
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert names(await drain(pubsub))[-1] == "error:INTERNAL"
    assert db.call(repo.get_track, job.track_id).status == "error"  # type: ignore[union-attr]


async def test_corrupt_source_key_is_internal(
    ctx: dict[str, Any],
    db: Database,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
) -> None:
    job = new_job(db, source_key="yt:not-an-id")
    await youtube.fetch_youtube(ctx, job.job_id)
    assert db.call(repo.get_track, job.track_id).error_code == "INTERNAL"  # type: ignore[union-attr]
    assert script.instances == []


# --- key detection is non-fatal ---------------------------------------------------------


@pytest.mark.parametrize(
    "error",
    [key_detection.KeyDetectionError("silence"), NotImplementedError(), MemoryError()],
)
async def test_key_detection_failure_is_non_fatal(
    ctx: dict[str, Any],
    db: Database,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    pubsub: Any,
    monkeypatch: pytest.MonkeyPatch,
    error: BaseException,
) -> None:
    def failing(path: Path) -> key_detection.KeyResult:
        raise error

    monkeypatch.setattr(key_detection, "detect_key", failing)
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert names(await drain(pubsub))[-4:] == [
        "audio_ready",
        "progress:analyzing",
        "error:KEY_DETECTION_FAILED",
        "done",
    ]
    track = db.call(repo.get_track, job.track_id)
    assert track is not None
    assert (track.status, track.error_code, track.key()) == ("ready", "KEY_DETECTION_FAILED", None)
    assert track.media_file
    assert db.call(repo.get_job, job.job_id).status == "done"  # type: ignore[union-attr]


# --- lifecycle edge cases ----------------------------------------------------------------


async def test_job_that_is_not_queued_is_skipped(
    ctx: dict[str, Any], db: Database, script: YtDlpScript, pubsub: Any
) -> None:
    job = new_job(db)
    db.call(repo.start_job, job.job_id)
    await youtube.fetch_youtube(ctx, job.job_id)
    await youtube.fetch_youtube(ctx, str(uuid.uuid4()))
    assert await drain(pubsub) == []
    assert script.instances == []


async def test_job_superseded_mid_run_leaves_no_files(
    ctx: dict[str, Any],
    db: Database,
    settings: Settings,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    detect_calls: list[dict[str, Any]],
    pubsub: Any,
) -> None:
    job = new_job(db)

    def delete_rows() -> None:
        conn = connect(db.path)
        conn.execute("DELETE FROM jobs")
        conn.execute("DELETE FROM tracks")

    script.on_extract = delete_rows
    await youtube.fetch_youtube(ctx, job.job_id)
    assert "error" not in [e for e, _ in await drain(pubsub)]
    assert os.listdir(settings.MEDIA_DIR) == []
    assert os.listdir(settings.TMP_DIR) == []


async def test_job_superseded_after_audio_ready_removes_media(
    ctx: dict[str, Any],
    db: Database,
    settings: Settings,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job = new_job(db)

    def detect_then_vanish(path: Path) -> key_detection.KeyResult:
        connect(db.path).execute("UPDATE tracks SET status = 'error'")
        return KEY_RESULT

    monkeypatch.setattr(key_detection, "detect_key", detect_then_vanish)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert os.listdir(settings.MEDIA_DIR) == []


async def test_key_failure_after_track_vanished(
    ctx: dict[str, Any],
    db: Database,
    settings: Settings,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job = new_job(db)

    def vanish_then_fail(path: Path) -> key_detection.KeyResult:
        connect(db.path).execute("UPDATE tracks SET status = 'error'")
        raise key_detection.KeyDetectionError("x")

    monkeypatch.setattr(key_detection, "detect_key", vanish_then_fail)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert os.listdir(settings.MEDIA_DIR) == []


async def test_track_vanishes_before_ready(
    ctx: dict[str, Any],
    db: Database,
    settings: Settings,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job = new_job(db)
    real = fake_ffmpeg.normalize

    async def normalize_then_vanish(src: Path, dst: Path, probed: ffmpeg.ProbeResult) -> None:
        await real(src, dst, probed)
        connect(db.path).execute("UPDATE tracks SET status = 'error'")

    monkeypatch.setattr(ffmpeg, "normalize_to_m4a", normalize_then_vanish)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert os.listdir(settings.MEDIA_DIR) == []


async def test_finish_job_race_still_emits_done(
    ctx: dict[str, Any],
    db: Database,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    monkeypatch: pytest.MonkeyPatch,
    pubsub: Any,
) -> None:
    job = new_job(db)

    def detect_and_close(path: Path) -> key_detection.KeyResult:
        connect(db.path).execute("UPDATE jobs SET status = 'done'")
        return KEY_RESULT

    monkeypatch.setattr(key_detection, "detect_key", detect_and_close)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert names(await drain(pubsub))[-1] == "done"


async def test_cancellation_records_failure_and_propagates(
    ctx: dict[str, Any],
    db: Database,
    settings: Settings,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = asyncio.Event()

    async def hang(src: Path, dst: Path, probed: ffmpeg.ProbeResult) -> None:
        started.set()
        await asyncio.sleep(3600)

    monkeypatch.setattr(ffmpeg, "normalize_to_m4a", hang)
    job = new_job(db)
    task = asyncio.create_task(youtube.fetch_youtube(ctx, job.job_id))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    track = db.call(repo.get_track, job.track_id)
    assert track is not None and (track.status, track.error_code) == ("error", "INTERNAL")
    assert not (Path(settings.TMP_DIR) / job.job_id).exists()


async def test_event_publish_failures_do_not_fail_the_job(
    settings: Settings,
    db: Database,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    detect_calls: list[dict[str, Any]],
) -> None:
    class BrokenRedis(fakeredis.FakeAsyncRedis):
        def pipeline(self, *args: Any, **kwargs: Any) -> Any:
            raise ConnectionError("valkey down")

    ctx = {"deps": WorkerDeps(settings=settings, db=db, redis=BrokenRedis())}
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert db.call(repo.get_track, job.track_id).status == "ready"  # type: ignore[union-attr]
    assert db.call(repo.get_job, job.job_id).status == "done"  # type: ignore[union-attr]


async def test_failure_recording_errors_are_survivable(
    ctx: dict[str, Any],
    db: Database,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    monkeypatch: pytest.MonkeyPatch,
    pubsub: Any,
) -> None:
    script.extract_error = DownloadError("Private video")

    def broken(*args: Any) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(repo, "fail_ingest", broken)
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert names(await drain(pubsub))[-1] == "error:SOURCE_UNAVAILABLE"


# --- uploads ---------------------------------------------------------------------------


def stage_upload(settings: Settings, job_id: str, data: bytes = b"ID3 staged upload") -> Path:
    path = staged_upload_path(settings, job_id)
    path.parent.mkdir(parents=True)
    path.write_bytes(data)
    return path


async def test_ingest_upload_end_to_end(
    ctx: dict[str, Any],
    db: Database,
    settings: Settings,
    fake_ffmpeg: FakeFFmpeg,
    detect_calls: list[dict[str, Any]],
    pubsub: Any,
) -> None:
    fake_ffmpeg.source = ffmpeg.ProbeResult(frozenset({"mp3"}), 180.0, ("mp3",), False)
    job = new_job(db, "up:0123456789abcdef", source="upload", title="My Song")
    stage_upload(settings, job.job_id)
    await upload.ingest_upload(ctx, job.job_id)

    recorded = await drain(pubsub)
    assert names(recorded) == [
        "progress:fetching",
        "progress:processing",
        "audio_ready",
        "progress:analyzing",
        "key_ready",
        "done",
    ]
    assert dict(recorded)["audio_ready"]["title"] == "My Song"
    track = db.call(repo.get_track, job.track_id)
    assert track is not None and track.status == "ready"
    assert (Path(settings.MEDIA_DIR) / str(track.media_file)).read_bytes() == b"ID3 staged upload"
    assert os.listdir(settings.TMP_DIR) == []


async def test_ingest_upload_untitled_fallback(
    ctx: dict[str, Any],
    db: Database,
    settings: Settings,
    fake_ffmpeg: FakeFFmpeg,
    detect_calls: list[dict[str, Any]],
    pubsub: Any,
) -> None:
    job = new_job(db, "up:0123456789abcdef", source="upload", title=None)
    stage_upload(settings, job.job_id)
    await upload.ingest_upload(ctx, job.job_id)
    assert dict(await drain(pubsub))["audio_ready"]["title"] == "Untitled"


async def test_ingest_upload_missing_staged_file(
    ctx: dict[str, Any], db: Database, fake_ffmpeg: FakeFFmpeg, pubsub: Any
) -> None:
    job = new_job(db, "up:0123456789abcdef", source="upload")
    await upload.ingest_upload(ctx, job.job_id)
    assert names(await drain(pubsub))[-1] == "error:INTERNAL"


async def test_ingest_upload_bad_media_is_unsupported(
    ctx: dict[str, Any], db: Database, settings: Settings, fake_ffmpeg: FakeFFmpeg, pubsub: Any
) -> None:
    fake_ffmpeg.normalize_error = ffmpeg.FFmpegError("ffmpeg exited with 1")
    job = new_job(db, "up:0123456789abcdef", source="upload")
    stage_upload(settings, job.job_id)
    await upload.ingest_upload(ctx, job.job_id)
    assert names(await drain(pubsub))[-1] == "error:UNSUPPORTED_FILE"
    assert os.listdir(settings.TMP_DIR) == []


# --- helpers -------------------------------------------------------------------------


def test_deno_runtime_points_at_the_venv_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    import deno

    monkeypatch.setattr(deno, "find_deno_bin", lambda: "/opt/venv/bin/deno")
    assert youtube.deno_runtime() == {"deno": {"path": "/opt/venv/bin/deno"}}

    def missing() -> str:
        raise FileNotFoundError

    monkeypatch.setattr(deno, "find_deno_bin", missing)
    assert youtube.deno_runtime() == {"deno": {}}


def test_ydl_params_are_valid_for_real_ytdlp(settings: Settings, tmp_path: Path) -> None:
    """The real YoutubeDL accepts our params (no network: construction only)."""
    import yt_dlp

    params = youtube.ydl_params(settings, tmp_path, lambda d: None)
    with yt_dlp.YoutubeDL(params) as ydl:
        assert ydl.params["noplaylist"] is True
        assert set(ydl.params["js_runtimes"]) == {"deno"}
        assert ydl.params["remote_components"] == set()


async def test_progress_drain_logs_publish_failures(
    settings: Settings, db: Database, caplog: pytest.LogCaptureFixture
) -> None:
    class Broken(fakeredis.FakeAsyncRedis):
        def pipeline(self, *args: Any, **kwargs: Any) -> Any:
            raise ConnectionError("down")

    track = repo.Track(
        "t",
        "yt:x",
        "youtube",
        None,
        None,
        "fetching",
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        "",
        "",
    )
    run = pipeline.JobRun(WorkerDeps(settings, db, Broken()), "j", track)
    progress = youtube.DownloadProgress(run, asyncio.get_running_loop())
    await asyncio.to_thread(progress.hook, {"status": "finished"})
    await progress.drain()
    assert "progress publish failed" in caplog.text


def test_download_ignores_reported_paths_outside_the_work_dir(tmp_path: Path) -> None:
    work = tmp_path / "job"
    work.mkdir()
    outside = tmp_path / "elsewhere.m4a"
    outside.write_bytes(b"x")
    (work / "source.m4a").write_bytes(b"audio")

    class Ydl:
        def process_ie_result(self, info: dict[str, Any], download: bool) -> dict[str, Any]:
            return {"requested_downloads": [{"filepath": str(outside)}, "junk", {}]}

    assert youtube._download(Ydl(), {}, work) == (work / "source.m4a").resolve()


async def test_fatal_error_after_ready_deletes_the_media(
    ctx: dict[str, Any],
    db: Database,
    settings: Settings,
    script: YtDlpScript,
    fake_ffmpeg: FakeFFmpeg,
    detect_calls: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
    pubsub: Any,
) -> None:
    def broken_save(*args: Any) -> bool:
        raise RuntimeError("disk I/O error")

    monkeypatch.setattr(repo, "save_key", broken_save)
    job = new_job(db)
    await youtube.fetch_youtube(ctx, job.job_id)
    assert names(await drain(pubsub))[-1] == "error:INTERNAL"
    track = db.call(repo.get_track, job.track_id)
    assert track is not None and (track.status, track.media_file) == ("error", None)
    assert os.listdir(settings.MEDIA_DIR) == []

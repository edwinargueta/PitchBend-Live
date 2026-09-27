"""Fakes for worker tests: yt-dlp, ffmpeg/ffprobe, key detection, and an event recorder."""

import json
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import fakeredis

from keyshift import events
from keyshift.audio import ffmpeg
from keyshift.audio.key_detection import KeyCandidate, KeyResult

VIDEO_ID = "dQw4w9WgXcQ"

KEY_RESULT = KeyResult(
    tonic="G",
    mode="major",
    confidence=0.82,
    alternates=(KeyCandidate("E", "minor", 0.71), KeyCandidate("C", "major", 0.4)),
    tuning_cents=-12,
)


def default_info(**overrides: Any) -> dict[str, Any]:
    info: dict[str, Any] = {
        "id": VIDEO_ID,
        "title": "Never  Gonna\tGive You Up\x07",
        "duration": 213,
        "live_status": "not_live",
        "is_live": False,
        "ext": "m4a",
    }
    info.update(overrides)
    return info


@dataclass
class YtDlpScript:
    """What the fake YoutubeDL does; tests tweak it before running a job."""

    info: dict[str, Any] = field(default_factory=default_info)
    extract_error: BaseException | None = None
    download_error: BaseException | None = None
    download_ext: str = "m4a"
    report_filepath: bool = True
    write_file: bool = True
    progress: list[dict[str, Any]] = field(
        default_factory=lambda: [
            {"status": "downloading", "downloaded_bytes": 0, "total_bytes": 1000},
            {"status": "downloading", "downloaded_bytes": 10, "total_bytes": 1000},
            {"status": "downloading", "downloaded_bytes": 500, "total_bytes_estimate": 1000},
            {"status": "downloading", "downloaded_bytes": 5},
            {"status": "error"},
            {"status": "finished"},
        ]
    )
    on_extract: Callable[[], None] | None = None
    instances: list[Any] = field(default_factory=list)


def fake_youtubedl(script: YtDlpScript) -> type:
    class FakeYoutubeDL:
        def __init__(self, params: dict[str, Any]) -> None:
            self.params = params
            self.urls: list[str] = []
            self.closed = False
            self.processed: dict[str, Any] | None = None
            script.instances.append(self)  # type: ignore[arg-type]

        def extract_info(self, url: str, download: bool = True) -> dict[str, Any]:
            assert download is False
            self.urls.append(url)
            if script.on_extract:
                script.on_extract()
            if script.extract_error:
                raise script.extract_error
            return dict(script.info)

        def process_ie_result(self, info: dict[str, Any], download: bool = True) -> dict[str, Any]:
            assert download is True
            self.processed = info
            if script.download_error:
                raise script.download_error
            for status in script.progress:
                for hook in self.params["progress_hooks"]:
                    hook(status)
            home = Path(self.params["paths"]["home"])
            path = home / f"source.{script.download_ext}"
            if script.write_file:
                path.write_bytes(b"fake downloaded audio")
                (home / "source.m4a.part").write_bytes(b"partial")
            result = dict(info)
            if script.report_filepath:
                result["requested_downloads"] = [{"filepath": str(path)}]
            return result

        def close(self) -> None:
            self.closed = True

    return FakeYoutubeDL


@dataclass
class FakeFFmpeg:
    """Replaces ffmpeg.probe/normalize_to_m4a so pipelines run without ffmpeg."""

    source: ffmpeg.ProbeResult = field(
        default_factory=lambda: ffmpeg.ProbeResult(
            frozenset({"mov", "mp4", "m4a"}), 213.0, ("aac",), False
        )
    )
    final_duration: float | None = 213.04
    probe_error: Exception | None = None
    normalize_error: Exception | None = None
    normalized: list[tuple[Path, Path]] = field(default_factory=list)

    async def probe(self, path: Path) -> ffmpeg.ProbeResult:
        if self.probe_error:
            raise self.probe_error
        if path.name == "audio.m4a":
            return ffmpeg.ProbeResult(
                frozenset({"mov", "mp4", "m4a"}), self.final_duration, ("aac",), False
            )
        return self.source

    async def normalize(self, src: Path, dst: Path, probed: ffmpeg.ProbeResult) -> None:
        if self.normalize_error:
            raise self.normalize_error
        self.normalized.append((src, dst))
        shutil.copyfile(src, dst)


def recorded_events(pubsub_messages: list[dict[str, Any]]) -> list[tuple[str, dict[str, Any]]]:
    out = []
    for message in pubsub_messages:
        doc = json.loads(message["data"])
        out.append((doc["event"], doc["data"]))
    return out


async def drain(pubsub: Any) -> list[tuple[str, dict[str, Any]]]:
    messages = []
    while True:
        message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.05)
        if message is None:
            # One more poll: the first None may just be the swallowed subscribe message.
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.05)
            if message is None:
                break
        messages.append(message)
    return recorded_events(messages)


def state_of(redis: fakeredis.FakeRedis, job_id: str) -> dict[str, Any] | None:
    raw = redis.get(events.state_key(job_id))
    return json.loads(raw) if raw else None

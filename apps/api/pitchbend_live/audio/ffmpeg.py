"""ffprobe/ffmpeg helpers (ARCHITECTURE.md §10 A3-A4, D8, CLAUDE.md §3).

Every call is an argv list run with ``asyncio.create_subprocess_exec``: no shell, and
paths are always our own (UUID/job-id based), never user-supplied names. stderr is
never logged (it can echo container metadata such as embedded titles).
"""

import asyncio
import contextlib
import json
import os
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

PROBE_TIMEOUT_S = 30.0
TRANSCODE_TIMEOUT_S = 600.0

# ffprobe format names accepted for uploads (ADR 0005 §11): mp3, wav, mp4/m4a/aac,
# flac, ogg/opus. ffprobe reports mp4-family files as "mov,mp4,m4a,3gp,3g2,mj2".
ALLOWED_FORMATS = frozenset({"mp3", "wav", "mov", "mp4", "m4a", "aac", "flac", "ogg"})
MP4_FAMILY = frozenset({"mov", "mp4", "m4a"})


class FFmpegError(Exception):
    """ffmpeg/ffprobe failed, timed out, or printed something unparseable."""


@dataclass(frozen=True)
class ProbeResult:
    format_names: frozenset[str]
    duration_s: float | None
    audio_codecs: tuple[str, ...]
    has_video: bool  # a real video stream (cover art doesn't count)

    @property
    def has_audio(self) -> bool:
        return bool(self.audio_codecs)

    @property
    def allowed_container(self) -> bool:
        return bool(self.format_names & ALLOWED_FORMATS)

    @property
    def is_aac(self) -> bool:
        return self.has_audio and self.audio_codecs[0] == "aac"

    @property
    def is_playback_ready(self) -> bool:
        """Already AAC in an mp4/m4a container with no video: serve as-is (D8)."""
        return self.is_aac and bool(self.format_names & MP4_FAMILY) and not self.has_video


async def run(argv: Sequence[str], *, timeout_s: float) -> tuple[int, bytes, bytes]:
    """Run ``argv`` (never a shell); kill it on timeout or cancellation."""
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout_s)
    except BaseException:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        with contextlib.suppress(BaseException):
            await asyncio.shield(proc.wait())
        raise
    assert proc.returncode is not None
    return proc.returncode, stdout, stderr


def probe_argv(path: Path) -> list[str]:
    return [
        FFPROBE,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_entries",
        "format=format_name,duration:stream=codec_type,codec_name,duration"
        ":stream_disposition=attached_pic",
        os.fspath(path),
    ]


def _float(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result and result not in (float("inf"), float("-inf")) else None


def parse_probe(doc: Any) -> ProbeResult:
    if not isinstance(doc, dict):
        raise FFmpegError("unexpected ffprobe output")
    raw_format = doc.get("format")
    fmt: dict[str, Any] = raw_format if isinstance(raw_format, dict) else {}
    streams = [s for s in doc.get("streams") or [] if isinstance(s, dict)]
    names = frozenset(n for n in str(fmt.get("format_name", "")).split(",") if n)
    audio = tuple(str(s.get("codec_name", "")) for s in streams if s.get("codec_type") == "audio")
    has_video = any(
        s.get("codec_type") == "video"
        and not (isinstance(s.get("disposition"), dict) and s["disposition"].get("attached_pic"))
        for s in streams
    )
    duration = _float(fmt.get("duration"))
    if duration is None:
        stream_durations = [d for s in streams if (d := _float(s.get("duration"))) is not None]
        duration = max(stream_durations) if stream_durations else None
    return ProbeResult(names, duration, audio, has_video)


async def probe(path: Path) -> ProbeResult:
    code, stdout, _stderr = await run(probe_argv(path), timeout_s=PROBE_TIMEOUT_S)
    if code != 0:
        raise FFmpegError(f"ffprobe exited with {code}")
    try:
        doc = json.loads(stdout)
    except ValueError as exc:
        raise FFmpegError("ffprobe printed invalid JSON") from exc
    return parse_probe(doc)


def transcode_argv(src: Path, dst: Path) -> list[str]:
    # §10 A3: ffmpeg -i in -vn -c:a aac -b:a 192k -movflags +faststart out.m4a
    return [
        FFMPEG,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        os.fspath(src),
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        os.fspath(dst),
    ]


def remux_argv(src: Path, dst: Path) -> list[str]:
    """AAC in another container (e.g. raw ADTS .aac, or mp4 with video): copy the audio."""
    return [
        FFMPEG,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        os.fspath(src),
        "-vn",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        os.fspath(dst),
    ]


def _discard(path: Path) -> None:
    """Remove a partial output (a single unlink; fine to call from async code)."""
    path.unlink(missing_ok=True)


async def _ffmpeg(argv: list[str], dst: Path) -> None:
    try:
        code, _stdout, _stderr = await run(argv, timeout_s=TRANSCODE_TIMEOUT_S)
    except BaseException:
        _discard(dst)
        raise
    if code != 0:
        _discard(dst)
        raise FFmpegError(f"ffmpeg exited with {code}")


async def transcode_to_m4a(src: Path, dst: Path) -> None:
    await _ffmpeg(transcode_argv(src, dst), dst)


async def remux_to_m4a(src: Path, dst: Path) -> None:
    await _ffmpeg(remux_argv(src, dst), dst)


async def normalize_to_m4a(src: Path, dst: Path, probed: ProbeResult) -> None:
    """Produce AAC-in-m4a at ``dst`` (D8): move if already playable, remux AAC, else
    transcode. ``src`` is consumed (moved or left for the caller's temp cleanup)."""
    if probed.is_playback_ready:
        await asyncio.to_thread(os.replace, src, dst)
    elif probed.is_aac:
        await remux_to_m4a(src, dst)
    else:
        await transcode_to_m4a(src, dst)

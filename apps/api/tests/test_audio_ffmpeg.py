"""ffprobe/ffmpeg helpers: unit tests everywhere, real-ffmpeg tests in the container."""

import asyncio
import json
import sys
from pathlib import Path

import pytest

from pitchbend_live.audio import ffmpeg
from pitchbend_live.audio.ffmpeg import FFmpegError, ProbeResult, parse_probe
from tests.conftest import requires_ffmpeg

pytestmark = pytest.mark.anyio

MP4 = frozenset({"mov", "mp4", "m4a", "3gp", "3g2", "mj2"})


def test_parse_probe_full() -> None:
    doc = {
        "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "213.400000"},
        "streams": [
            {"codec_type": "audio", "codec_name": "aac", "duration": "213.4"},
            {"codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}},
        ],
    }
    result = parse_probe(doc)
    assert result == ProbeResult(MP4, 213.4, ("aac",), False)
    assert result.has_audio and result.allowed_container and result.is_aac
    assert result.is_playback_ready


@pytest.mark.parametrize(
    ("doc", "expected"),
    [
        ({}, ProbeResult(frozenset(), None, (), False)),
        ({"format": "x", "streams": "y"}, ProbeResult(frozenset(), None, (), False)),
        (
            {
                "format": {"format_name": "ogg"},
                "streams": [
                    {"codec_type": "audio", "codec_name": "opus", "duration": "3.5"},
                    "junk",
                ],
            },
            ProbeResult(frozenset({"ogg"}), 3.5, ("opus",), False),
        ),
        (
            {"format": {"format_name": "wav", "duration": "nan"}, "streams": []},
            ProbeResult(frozenset({"wav"}), None, (), False),
        ),
        (
            {
                "format": {"format_name": "mp3", "duration": "inf"},
                "streams": [{"codec_type": "audio", "codec_name": "mp3", "duration": "N/A"}],
            },
            ProbeResult(frozenset({"mp3"}), None, ("mp3",), False),
        ),
        (
            {
                "format": {"format_name": "mov,mp4", "duration": "5"},
                "streams": [
                    {"codec_type": "video", "codec_name": "h264"},
                    {"codec_type": "audio", "codec_name": "aac"},
                ],
            },
            ProbeResult(frozenset({"mov", "mp4"}), 5.0, ("aac",), True),
        ),
    ],
)
def test_parse_probe_edge_cases(doc: object, expected: ProbeResult) -> None:
    assert parse_probe(doc) == expected


def test_parse_probe_rejects_non_objects() -> None:
    with pytest.raises(FFmpegError):
        parse_probe([1, 2])


@pytest.mark.parametrize(
    ("result", "allowed", "ready"),
    [
        (ProbeResult(frozenset({"matroska", "webm"}), 1.0, ("opus",), False), False, False),
        (ProbeResult(frozenset({"aac"}), 1.0, ("aac",), False), True, False),  # ADTS
        (ProbeResult(MP4, 1.0, ("aac",), True), True, False),  # has video
        (ProbeResult(MP4, 1.0, ("alac",), False), True, False),
        (ProbeResult(frozenset({"flac"}), 1.0, ("flac",), False), True, False),
    ],
)
def test_container_rules(result: ProbeResult, allowed: bool, ready: bool) -> None:
    assert result.allowed_container is allowed
    assert result.is_playback_ready is ready


def test_argv_lists_never_use_a_shell(tmp_path: Path) -> None:
    src, dst = tmp_path / "in put;rm -rf.mp3", tmp_path / "out.m4a"
    probe = ffmpeg.probe_argv(src)
    assert probe[0] == "ffprobe" and probe[-1] == str(src)
    transcode = ffmpeg.transcode_argv(src, dst)
    assert transcode[0] == "ffmpeg"
    # §10 A3: -i in -vn -c:a aac -b:a 192k -movflags +faststart out.m4a
    joined = " ".join(transcode)
    assert f"-i {src} -vn -c:a aac -b:a 192k -movflags +faststart {dst}" in joined
    assert transcode[transcode.index("-i") + 1] == str(src)  # one argv element, unquoted
    remux = ffmpeg.remux_argv(src, dst)
    assert remux[remux.index("-c:a") + 1] == "copy" and "-vn" in remux


async def test_run_success_failure_and_timeout() -> None:
    code, out, err = await ffmpeg.run(
        [sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr)"],
        timeout_s=10,
    )
    assert (code, out.strip(), err.strip()) == (0, b"out", b"err")
    code, _, _ = await ffmpeg.run([sys.executable, "-c", "raise SystemExit(3)"], timeout_s=10)
    assert code == 3
    with pytest.raises(TimeoutError):
        await ffmpeg.run([sys.executable, "-c", "import time; time.sleep(30)"], timeout_s=0.2)


async def test_probe_errors(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    replies = iter(
        [
            (1, b"", b"bad"),
            (0, b"not json", b""),
            (0, json.dumps({"format": {"format_name": "mp3"}}).encode(), b""),
        ]
    )

    async def fake_run(argv: list[str], *, timeout_s: float) -> tuple[int, bytes, bytes]:
        return next(replies)

    monkeypatch.setattr(ffmpeg, "run", fake_run)
    with pytest.raises(FFmpegError, match="exited"):
        await ffmpeg.probe(tmp_path / "x")
    with pytest.raises(FFmpegError, match="JSON"):
        await ffmpeg.probe(tmp_path / "x")
    assert (await ffmpeg.probe(tmp_path / "x")).format_names == {"mp3"}


async def test_failed_ffmpeg_removes_partial_output(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    dst = tmp_path / "out.m4a"

    async def failing(argv: list[str], *, timeout_s: float) -> tuple[int, bytes, bytes]:
        dst.write_bytes(b"partial")
        return 1, b"", b""

    monkeypatch.setattr(ffmpeg, "run", failing)
    with pytest.raises(FFmpegError):
        await ffmpeg.transcode_to_m4a(tmp_path / "in.mp3", dst)
    assert not dst.exists()

    async def crashing(argv: list[str], *, timeout_s: float) -> tuple[int, bytes, bytes]:
        dst.write_bytes(b"partial")
        raise TimeoutError

    monkeypatch.setattr(ffmpeg, "run", crashing)
    with pytest.raises(TimeoutError):
        await ffmpeg.remux_to_m4a(tmp_path / "in.aac", dst)
    assert not dst.exists()


async def test_normalize_dispatch(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[str] = []

    async def fake_transcode(src: Path, dst: Path) -> None:
        calls.append("transcode")

    async def fake_remux(src: Path, dst: Path) -> None:
        calls.append("remux")

    monkeypatch.setattr(ffmpeg, "transcode_to_m4a", fake_transcode)
    monkeypatch.setattr(ffmpeg, "remux_to_m4a", fake_remux)
    src, dst = tmp_path / "src", tmp_path / "dst.m4a"
    src.write_bytes(b"m4a")
    await ffmpeg.normalize_to_m4a(src, dst, ProbeResult(MP4, 1.0, ("aac",), False))
    assert dst.read_bytes() == b"m4a" and not src.exists() and calls == []
    await ffmpeg.normalize_to_m4a(src, dst, ProbeResult(frozenset({"aac"}), 1.0, ("aac",), False))
    await ffmpeg.normalize_to_m4a(src, dst, ProbeResult(MP4, 1.0, ("aac",), True))
    await ffmpeg.normalize_to_m4a(src, dst, ProbeResult(frozenset({"mp3"}), 1.0, ("mp3",), False))
    assert calls == ["remux", "remux", "transcode"]


# --- real ffmpeg (container only) ---------------------------------------------------------

# (extension, extra ffmpeg args, expected sniff family, expected format name)
FORMATS = [
    ("mp3", ["-c:a", "libmp3lame"], "mp3", "mp3"),
    ("wav", ["-c:a", "pcm_s16le"], "wav", "wav"),
    ("flac", ["-c:a", "flac"], "flac", "flac"),
    ("ogg", ["-c:a", "libvorbis"], "ogg", "ogg"),
    ("opus", ["-c:a", "libopus", "-f", "ogg"], "ogg", "ogg"),
    ("m4a", ["-c:a", "aac"], "mp4", "mp4"),
    ("aac", ["-c:a", "aac", "-f", "adts"], "aac", "aac"),
]


async def make_fixture(path: Path, extra: list[str], seconds: float = 1.0) -> Path:
    code, _, err = await ffmpeg.run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={seconds}",
            *extra,
            str(path),
        ],
        timeout_s=60,
    )
    assert code == 0, err.decode()
    return path


@requires_ffmpeg
@pytest.mark.parametrize(("ext", "extra", "family", "fmt"), FORMATS)
async def test_real_fixtures_probe_sniff_and_normalize(
    tmp_path: Path, ext: str, extra: list[str], family: str, fmt: str
) -> None:
    from pitchbend_live.audio.sniff import sniff_audio

    src = await make_fixture(tmp_path / f"tone.{ext}", extra)
    assert sniff_audio(src.read_bytes()[:16]) == family
    probed = await ffmpeg.probe(src)
    assert probed.has_audio and probed.allowed_container
    assert fmt in probed.format_names
    assert probed.duration_s is not None and abs(probed.duration_s - 1.0) < 0.1

    out = tmp_path / "audio.m4a"
    await ffmpeg.normalize_to_m4a(src, out, probed)
    final = await ffmpeg.probe(out)
    assert final.is_playback_ready, final
    assert final.duration_s is not None and abs(final.duration_s - 1.0) < 0.1


@requires_ffmpeg
async def test_real_video_file_keeps_only_audio(tmp_path: Path) -> None:
    src = tmp_path / "clip.mp4"
    code, _, err = await ffmpeg.run(
        [
            "ffmpeg",
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=64x64:rate=5:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=1",
            "-c:v",
            "mpeg4",
            "-c:a",
            "aac",
            "-shortest",
            str(src),
        ],
        timeout_s=60,
    )
    assert code == 0, err.decode()
    probed = await ffmpeg.probe(src)
    assert probed.has_video and probed.is_aac and not probed.is_playback_ready
    out = tmp_path / "audio.m4a"
    await ffmpeg.normalize_to_m4a(src, out, probed)
    assert (await ffmpeg.probe(out)).is_playback_ready


@requires_ffmpeg
async def test_real_non_audio_has_no_usable_audio(tmp_path: Path) -> None:
    junk = tmp_path / "junk.mp3"
    junk.write_bytes(b"ID3" + b"\x00" * 64)
    try:
        probed = await ffmpeg.probe(junk)
    except FFmpegError:
        return
    assert not probed.has_audio or not probed.duration_s


@requires_ffmpeg
async def test_real_transcode_failure(tmp_path: Path) -> None:
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"RIFF\x00\x00\x00\x00WAVEjunk")
    with pytest.raises(FFmpegError):
        await ffmpeg.transcode_to_m4a(junk, tmp_path / "out.m4a")
    assert not (tmp_path / "out.m4a").exists()


def test_ffmpeg_helpers_are_importable_without_binaries() -> None:
    # The module must import on hosts without ffmpeg; only calls need the binaries.
    assert asyncio.iscoroutinefunction(ffmpeg.probe)

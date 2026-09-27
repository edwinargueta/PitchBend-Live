"""Key detection on synthetic audio (ARCHITECTURE.md §10 A5). No ffmpeg needed.

The ffmpeg-backed `decode()` / `detect_key()` tests and the 4-minute performance test
live in test_key_detection_ffmpeg.py.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from key_fixtures import synth

from keyshift.audio import key_detection as kd
from keyshift.audio.key_detection import (
    PITCH_CLASSES,
    KeyCandidate,
    KeyDetectionError,
    KeyResult,
    Mode,
    detect_key,
    detect_key_from_samples,
)

SR = synth.SR


def assert_key(result: KeyResult, tonic: str, mode: Mode) -> None:
    """The expected key ranks first, or the relative key does and the expected one is an
    alternate (the only confusion §10 A5 allows)."""
    top = (result.tonic, result.mode)
    alternates = [(a.tonic, a.mode) for a in result.alternates]
    if top == (tonic, mode):
        return
    assert top == synth.relative_key(tonic, mode), f"expected {tonic} {mode}, got {result}"
    assert (tonic, mode) in alternates, f"relative key on top but {tonic} {mode} not in {result}"


def assert_well_formed(result: KeyResult) -> None:
    candidates = [result, *result.alternates]
    assert len(result.alternates) == kd.N_ALTERNATES == 2
    assert len({(c.tonic, c.mode) for c in candidates}) == 3  # all distinct
    for c in candidates:
        assert c.tonic in PITCH_CLASSES
        assert c.mode in ("major", "minor")
        assert isinstance(c.confidence, float)
        assert 0.0 <= c.confidence <= 1.0
        assert c.confidence == round(c.confidence, 2)
    confidences = [c.confidence for c in candidates]
    assert confidences == sorted(confidences, reverse=True)
    assert sum(confidences) <= 1.0 + 0.015  # softmax shares, give or take rounding
    assert isinstance(result.tuning_cents, int)
    assert -50 <= result.tuning_cents <= 50


# --------------------------------------------------------------------------- import cost


def test_importing_the_module_does_not_import_librosa() -> None:
    """The API process imports this module; librosa (numba, scipy) must load lazily."""
    code = (
        "import sys, keyshift.audio.key_detection\n"
        "heavy = [m for m in ('librosa', 'numba', 'scipy') if m in sys.modules]\n"
        "assert not heavy, heavy\n"
    )
    subprocess.run([sys.executable, "-c", code], check=True, timeout=60)


def test_warm_up_runs_a_detection(monkeypatch: pytest.MonkeyPatch) -> None:
    results: list[KeyResult] = []
    real = kd.detect_key_from_samples

    def spy(y: np.ndarray[Any, Any], sr: int) -> KeyResult:
        results.append(real(y, sr))
        return results[-1]

    monkeypatch.setattr(kd, "detect_key_from_samples", spy)
    kd.warm_up()
    [result] = results
    assert result.tonic == "A"


# --------------------------------------------------------------------------- clear fixtures


@pytest.mark.parametrize("kind", sorted(synth.FIXTURE_KINDS))
@pytest.mark.parametrize(("tonic", "mode"), synth.ALL_KEYS, ids=lambda v: str(v))
def test_clear_fixture_detects_its_key(kind: str, tonic: str, mode: Mode) -> None:
    y = synth.FIXTURE_KINDS[kind](tonic, mode)
    result = detect_key_from_samples(y, SR)
    assert_key(result, tonic, mode)
    assert_well_formed(result)
    assert abs(result.tuning_cents) <= 3


@pytest.mark.parametrize("cents", [-45, -20, 15, 45])
@pytest.mark.parametrize(("tonic", "mode"), [("C", "major"), ("F#", "minor"), ("A#", "major")])
def test_detuned_fixture_reports_tuning_and_key(tonic: str, mode: Mode, cents: int) -> None:
    for make in (synth.cadence_fixture, synth.scale_fixture):
        result = detect_key_from_samples(make(tonic, mode, cents=cents), SR)
        assert_key(result, tonic, mode)
        assert abs(result.tuning_cents - cents) <= 3, result


def test_clear_fixtures_are_confident() -> None:
    for tonic, mode in [("E", "major"), ("C#", "minor"), ("G", "major")]:
        assert detect_key_from_samples(synth.triad_fixture(tonic, mode), SR).confidence >= 0.8
        assert detect_key_from_samples(synth.scale_fixture(tonic, mode), SR).confidence >= 0.8


def test_robust_to_drums_and_noise() -> None:
    rng = np.random.default_rng(11)
    for tonic, mode in [("D", "major"), ("B", "minor"), ("G#", "major"), ("F", "minor")]:
        y = synth.at_snr(
            synth.mix(synth.cadence_fixture(tonic, mode), synth.drums(8.0, seed=3)),
            synth.colored_noise(8.0, 1.0, seed=int(rng.integers(1000))),
            snr_db=10.0,
        )
        assert_key(detect_key_from_samples(y, SR), tonic, mode)


def test_harmonic_separation_option(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kd, "HARMONIC_SEPARATION", True)
    y = synth.mix(synth.cadence_fixture("A", "minor"), synth.drums(8.0))
    assert_key(detect_key_from_samples(y, SR), "A", "minor")


def test_single_note_is_ambiguous_between_its_modes() -> None:
    result = detect_key_from_samples(synth.tone(69, 5.0), SR)  # a lone A4
    top_two = {(result.tonic, result.mode), (result.alternates[0].tonic, result.alternates[0].mode)}
    assert top_two == {("A", "major"), ("A", "minor")}
    assert result.confidence < 0.8


def test_short_silences_and_fades_do_not_matter() -> None:
    y = synth.cadence_fixture("D#", "major")
    padded = np.concatenate([np.zeros(3 * SR, np.float32), y, 1e-4 * synth.white_noise(3.0)])
    assert_key(detect_key_from_samples(padded, SR), "D#", "major")


def test_higher_sample_rates_work() -> None:
    y = synth.cadence_fixture("G", "minor")
    y48 = np.interp(np.arange(0, len(y), SR / 48_000), np.arange(len(y)), y).astype(np.float32)
    assert_key(detect_key_from_samples(y48, 48_000), "G", "minor")


# --------------------------------------------------------------------------- failures


@pytest.mark.parametrize(
    ("y", "message"),
    [
        (np.zeros(0, np.float32), "too short"),
        (synth.triad_fixture("C", "major", dur=2.0), "too short"),
        (np.zeros(5 * SR, np.float32), "silent"),
        (1e-4 * synth.cadence_fixture("C", "major"), "silent"),  # ~-90 dBFS
        (np.full(5 * SR, np.nan, np.float32), "non-finite"),
        (synth.white_noise(5.0), "no clear tonal content"),
        (synth.white_noise(30.0, seed=1), "no clear tonal content"),
        (synth.colored_noise(5.0, 1.0), "no clear tonal content"),
        (synth.colored_noise(3.0, 2.0, seed=2), "no clear tonal content"),
        (synth.drums(8.0), "no clear tonal content"),
        (synth.mix(synth.drums(8.0), synth.colored_noise(8.0, 2.0)), "no clear tonal content"),
    ],
    ids=[
        "empty",
        "too-short",
        "silence",
        "near-silence",
        "nan",
        "white-noise",
        "white-noise-30s",
        "pink-noise",
        "brown-noise-3s",
        "drums",
        "drums-and-brown-noise",
    ],
)
@pytest.mark.filterwarnings("ignore:Trying to estimate tuning from empty frequency set")
def test_undeterminable_audio_raises(y: np.ndarray[Any, Any], message: str) -> None:
    with pytest.raises(KeyDetectionError, match=message):
        detect_key_from_samples(y, SR)


def test_non_mono_input_is_a_programming_error() -> None:
    with pytest.raises(ValueError, match="mono"):
        detect_key_from_samples(np.zeros((2, 5 * SR), np.float32), SR)


def test_too_low_sample_rate_is_a_programming_error() -> None:
    with pytest.raises(ValueError, match="sample rate"):
        detect_key_from_samples(np.zeros(5 * 8000, np.float32), 8000)


def test_flat_profile_has_no_key() -> None:
    with pytest.raises(KeyDetectionError, match="tonal"):
        kd._correlations(np.ones(12))


def test_salience_of_empty_cqt_is_zero() -> None:
    assert kd._salience(np.zeros((kd.N_OCTAVES * kd.BINS_PER_OCTAVE, 4))) == 0.0


# --------------------------------------------------------------------------- scoring


def test_correlations_match_rotated_krumhansl_kessler_profiles() -> None:
    for i, (tonic, mode) in enumerate(kd.CANDIDATES):
        base = kd.KK_MAJOR if mode == "major" else kd.KK_MINOR
        profile = np.roll(np.array(base), PITCH_CLASSES.index(tonic))
        r = kd._correlations(profile)
        assert int(np.argmax(r)) == i
        assert r[i] == pytest.approx(1.0)
        expected = [
            np.corrcoef(profile, np.roll(np.array(b), t))[0, 1]
            for b in (kd.KK_MAJOR, kd.KK_MINOR)
            for t in range(12)
        ]
        assert r == pytest.approx(expected)


def test_confidences_are_a_temperature_softmax() -> None:
    r = np.linspace(-0.5, 0.9, 24)
    p = kd._confidences(r)
    expected = np.exp(r / kd.SOFTMAX_TEMPERATURE)
    assert p == pytest.approx(expected / expected.sum())
    assert p.sum() == pytest.approx(1.0)
    assert list(np.argsort(p)) == list(range(24))


def test_confidence_ordering_and_rounding(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ranks come from the correlations; ties keep candidate order; values round to 0.01."""
    r = np.zeros(24)
    r[kd.CANDIDATES.index(("G", "major"))] = 0.9
    r[kd.CANDIDATES.index(("E", "minor"))] = 0.8
    r[kd.CANDIDATES.index(("C", "major"))] = 0.8
    monkeypatch.setattr(kd, "_pitch_class_profile", lambda y, sr: (np.ones(12), -0.123))
    monkeypatch.setattr(kd, "_correlations", lambda profile: r)
    result = detect_key_from_samples(synth.white_noise(5.0), SR)
    p = kd._confidences(r)
    assert (result.tonic, result.mode) == ("G", "major")
    assert result.confidence == round(float(p.max()), 2)
    assert [(a.tonic, a.mode) for a in result.alternates] == [("C", "major"), ("E", "minor")]
    assert result.alternates[0].confidence == result.alternates[1].confidence
    assert result.tuning_cents == -12


@pytest.mark.parametrize(("tuning", "cents"), [(0.7, 50), (-0.7, -50), (0.495, 50), (-0.5, -50)])
def test_tuning_cents_is_rounded_and_clamped(
    monkeypatch: pytest.MonkeyPatch, tuning: float, cents: int
) -> None:
    profile = np.roll(np.array(kd.KK_MAJOR), 2)
    monkeypatch.setattr(kd, "_pitch_class_profile", lambda y, sr: (profile, tuning))
    result = detect_key_from_samples(synth.white_noise(5.0), SR)
    assert result.tuning_cents == cents
    assert (result.tonic, result.mode) == ("D", "major")


# --------------------------------------------------------------------------- wire format


def test_to_dict_matches_the_track_key_object() -> None:
    """§6.4 `key` object / §6.5 `key_ready` payload."""
    result = detect_key_from_samples(synth.cadence_fixture("G", "major"), SR)
    d = result.to_dict()
    assert list(d) == ["tonic", "mode", "confidence", "alternates", "tuning_cents"]
    assert (d["tonic"], d["mode"]) == ("G", "major")
    assert isinstance(d["confidence"], float)
    assert isinstance(d["tuning_cents"], int)
    alternates = d["alternates"]
    assert isinstance(alternates, list) and len(alternates) == 2
    for a, candidate in zip(alternates, result.alternates, strict=True):
        assert a == {
            "tonic": candidate.tonic,
            "mode": candidate.mode,
            "confidence": candidate.confidence,
        }
    assert json.loads(json.dumps(d)) == d


def test_to_dict_example_from_the_spec() -> None:
    result = KeyResult(
        tonic="G",
        mode="major",
        confidence=0.82,
        alternates=(KeyCandidate("E", "minor", 0.11), KeyCandidate("C", "major", 0.03)),
        tuning_cents=-12,
    )
    assert result.to_dict() == {
        "tonic": "G",
        "mode": "major",
        "confidence": 0.82,
        "alternates": [
            {"tonic": "E", "mode": "minor", "confidence": 0.11},
            {"tonic": "C", "mode": "major", "confidence": 0.03},
        ],
        "tuning_cents": -12,
    }


# --------------------------------------------------------------------------- decode + compose


class FakeRun:
    """Stands in for subprocess.run; records the call."""

    def __init__(self, *, stdout: bytes = b"", stderr: bytes = b"", returncode: int = 0) -> None:
        self.result = subprocess.CompletedProcess([], returncode, stdout, stderr)
        self.calls: list[tuple[list[str], dict[str, Any]]] = []

    def __call__(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        self.calls.append((argv, kwargs))
        return self.result


def test_decode_runs_ffmpeg_from_an_argv_list(monkeypatch: pytest.MonkeyPatch) -> None:
    samples = np.array([0.0, 0.5, -0.25], dtype="<f4")
    fake = FakeRun(stdout=samples.tobytes())
    monkeypatch.setattr(kd.subprocess, "run", fake)
    y, sr = kd.decode(Path("/data/media/-odd name.m4a"))
    assert sr == 22_050
    assert y.dtype == np.float32
    assert y.tolist() == [0.0, 0.5, -0.25]
    [(argv, kwargs)] = fake.calls
    assert argv[0] == "ffmpeg"
    assert argv[argv.index("-i") + 1] == "file:/data/media/-odd name.m4a"
    assert argv[argv.index("-ac") + 1] == "1"
    assert argv[argv.index("-ar") + 1] == "22050"
    assert argv[argv.index("-f") + 1] == "f32le"
    assert argv[-1] == "pipe:1"
    assert "shell" not in kwargs
    assert kwargs["timeout"] == kd.DECODE_TIMEOUT_S


@pytest.mark.parametrize(
    ("stderr", "message"),
    [
        (b"x\nfile:/nope.m4a: No such file or directory\n", "exit 1.*No such file or directory"),
        (b"", "exit 1.*no error output"),
    ],
)
def test_decode_failure_raises(
    monkeypatch: pytest.MonkeyPatch, stderr: bytes, message: str
) -> None:
    monkeypatch.setattr(kd.subprocess, "run", FakeRun(stderr=stderr, returncode=1))
    with pytest.raises(KeyDetectionError, match=message):
        kd.decode(Path("/nope.m4a"))


def test_decode_of_no_samples_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kd.subprocess, "run", FakeRun(stdout=b""))
    with pytest.raises(KeyDetectionError, match="no audio"):
        kd.decode(Path("/empty.m4a"))


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (FileNotFoundError(2, "No such file or directory", "ffmpeg"), "can't run ffmpeg"),
        (PermissionError(13, "Permission denied", "ffmpeg"), "can't run ffmpeg"),
        (subprocess.TimeoutExpired(["ffmpeg"], kd.DECODE_TIMEOUT_S), "timed out"),
    ],
)
def test_decode_process_errors_raise(
    monkeypatch: pytest.MonkeyPatch, error: Exception, message: str
) -> None:
    def run(argv: list[str], **kwargs: Any) -> None:
        raise error

    monkeypatch.setattr(kd.subprocess, "run", run)
    with pytest.raises(KeyDetectionError, match=message) as info:
        kd.decode(Path("/song.m4a"))
    assert info.value.__cause__ is error


def test_detect_key_composes_decode_and_analysis(monkeypatch: pytest.MonkeyPatch) -> None:
    y = synth.scale_fixture("F", "minor")
    seen: list[Path] = []

    def decode(path: Path) -> tuple[np.ndarray[Any, Any], int]:
        seen.append(path)
        return y, SR

    monkeypatch.setattr(kd, "decode", decode)
    result = detect_key(Path("/data/media/x.m4a"))
    assert seen == [Path("/data/media/x.m4a")]
    assert result == detect_key_from_samples(y, SR)
    assert_key(result, "F", "minor")


def test_detect_key_passes_key_detection_errors_through(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kd, "decode", lambda path: (np.zeros(5 * SR, np.float32), SR))
    with pytest.raises(KeyDetectionError, match="silent") as info:
        detect_key(Path("/data/media/x.m4a"))
    assert info.value.__cause__ is None


def test_detect_key_turns_unexpected_errors_into_key_detection_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A key-detection bug must never fail the ingest job (§6.5): it becomes non-fatal."""
    boom = RuntimeError("cannot cache function")

    def analyze(y: object, sr: int) -> KeyResult:
        raise boom

    monkeypatch.setattr(kd, "decode", lambda path: (np.zeros(5 * SR, np.float32), SR))
    monkeypatch.setattr(kd, "detect_key_from_samples", analyze)
    with pytest.raises(KeyDetectionError, match="RuntimeError") as info:
        detect_key(Path("/data/media/x.m4a"))
    assert info.value.__cause__ is boom

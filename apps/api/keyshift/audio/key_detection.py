"""Musical key detection (ARCHITECTURE.md §10 A5, ADR 0005 §13).

Contract shared by two workstreams: the key-detection workstream implements
`detect_key`; the ingest pipeline only calls it (off the event loop, via
`asyncio.to_thread`) and serializes the result with `KeyResult.to_dict()`.

Algorithm (D9): decode to mono 22,050 Hz with ffmpeg, estimate the tuning offset, take a
tuning-corrected constant-Q transform, reject audio without pitched content, fold the CQT
into a chromagram, sum it over the non-silent frames, and Pearson-correlate that
pitch-class profile with the 24 rotations of the Krumhansl-Kessler major/minor profiles.
Confidence is a temperature softmax over the 24 correlations.

numpy and librosa (which pulls in numba and scipy) are imported lazily inside the
functions, so importing this module from the API process stays cheap.
"""

from __future__ import annotations

import math
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    import numpy as np
    import numpy.typing as npt

# Sharps-only canonical spelling; the browser owns display spelling (ADR 0005 §13).
PITCH_CLASSES: tuple[str, ...] = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")

Mode = Literal["major", "minor"]


class KeyDetectionError(Exception):
    """The key couldn't be determined. Non-fatal: the pipeline emits KEY_DETECTION_FAILED."""


@dataclass(frozen=True)
class KeyCandidate:
    tonic: str  # one of PITCH_CLASSES
    mode: Mode
    confidence: float  # 0..1, rounded to 2 decimals

    def to_dict(self) -> dict[str, object]:
        return {"tonic": self.tonic, "mode": self.mode, "confidence": self.confidence}


@dataclass(frozen=True)
class KeyResult:
    tonic: str  # one of PITCH_CLASSES
    mode: Mode
    confidence: float  # 0..1, rounded to 2 decimals
    alternates: tuple[KeyCandidate, ...]  # the next 2 candidates, best first
    tuning_cents: int  # -50..50

    def to_dict(self) -> dict[str, object]:
        """The `key` object of GET /api/tracks and the `key_ready` SSE payload (§6.4, §6.5)."""
        return {
            "tonic": self.tonic,
            "mode": self.mode,
            "confidence": self.confidence,
            "alternates": [a.to_dict() for a in self.alternates],
            "tuning_cents": self.tuning_cents,
        }


# --------------------------------------------------------------------------- parameters

SAMPLE_RATE = 22_050
"""Decode rate (§10 A5)."""

DECODE_TIMEOUT_S = 120.0
"""ffmpeg wall-clock limit; a 12-minute track (MAX_DURATION_S) decodes in a few seconds."""

MIN_DURATION_S = 3.0
"""Shorter audio can't establish a key (and is too short for the lowest CQT octave)."""

SILENCE_RMS = 1e-3
"""Overall RMS below -60 dBFS counts as silence."""

BINS_PER_OCTAVE = 36
"""CQT resolution: 3 bins per semitone (centre, +1/3, +2/3), folded into 12 chroma bins."""

FMIN_HZ = 440.0 * 2.0 ** ((36 - 69) / 12)
"""Lowest CQT bin: C2 (65.4 Hz). Below it is mostly kick drum and rumble; bass notes lower
than C2 still register through their harmonics."""

N_OCTAVES = 6
"""CQT range C2-B7."""

HOP_LENGTH = 1024
"""CQT frame hop (~46 ms). Key detection needs no finer time resolution, and the CQT
filters stay longer than the hop up to ~1.1 kHz, so no melody or harmony note is skipped."""

TUNING_HOP_LENGTH = 2048
"""Hop of the STFT that `estimate_tuning` peak-picks (n_fft 2048). As accurate as librosa's
default 512 on the fixtures (within 2 cents) with a quarter of the memory: a 12-minute track
peaks well under the worker's 2 GiB limit."""

FRAME_GATE = 0.01
"""Frames whose peak CQT magnitude is under 1% (-40 dB) of the loud (95th-percentile)
frames' are ignored, so silences and fades don't dilute the profile."""

MIN_SALIENCE = 1.1
"""Minimum pitch salience (`_salience`). Measured on synthetic audio: 250 seeded 3-10 s
clips of white, pink and brown noise and drums give 1.00-1.08; clear fixtures give 1.6-1.9;
random progressions with drums buried in pink noise at 0 to -6 dB SNR still give >= 1.17."""

HARMONIC_SEPARATION = False
"""Run `librosa.effects.harmonic` first. Off: for 4 minutes of audio in the api image at
--cpus=1 it raises detection from ~0.5 s to ~8-9 s, over the 5 s budget (§10 A5)."""

SOFTMAX_TEMPERATURE = 0.07
"""Softmax temperature over the 24 Pearson correlations (see `_confidences`).

Chosen by temperature scaling (`scripts/bench_key_detection.py calibrate`): over 192
randomized synthetic songs (8 per key; drums, pink noise down to 0 dB SNR, +-30 cents of
detuning, progressions that may not start or end on the tonic), the mean negative
log-likelihood of the true key is lowest at 0.065 (seed 2026) and 0.070 (seed 7). There the
mean top confidence (0.84) matches the top-1 accuracy (83-85%), i.e. it is calibrated. 0.07
is the slightly conservative end, as real recordings are harder than synthetic songs."""

N_ALTERNATES = 2

# Krumhansl & Kessler (1982) probe-tone ratings, index 0 = tonic.
KK_MAJOR = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
KK_MINOR = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)

# The 24 candidates in `_correlations` order: C..B major, then C..B minor.
CANDIDATES: tuple[tuple[str, Mode], ...] = tuple(
    (tonic, mode) for mode in ("major", "minor") for tonic in PITCH_CLASSES
)


# --------------------------------------------------------------------------- public API


def detect_key(path: Path) -> KeyResult:
    """Detect the key of the audio file at `path`.

    Blocking and CPU-bound: callers must run it off the event loop. Raises
    KeyDetectionError when no key can be determined (e.g. silence).

    Any other failure (a librosa or numba error, MemoryError, ...) is re-raised as
    KeyDetectionError too, chained to the original, so a key-detection bug can never fail
    the ingest job (§6.5); log it with its traceback.
    """
    try:
        y, sr = decode(path)
        return detect_key_from_samples(y, sr)
    except KeyDetectionError:
        raise
    except Exception as exc:
        raise KeyDetectionError(f"key detection failed: {type(exc).__name__}") from exc


def decode(path: Path) -> tuple[npt.NDArray[np.float32], int]:
    """Decode the first audio stream of `path` to mono float32 at `SAMPLE_RATE` with ffmpeg.

    ffmpeg runs from an argv list (no shell). Raises KeyDetectionError if ffmpeg is
    missing, fails, times out, or produces no samples.
    """
    import numpy as np

    argv = [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        # The file: protocol keeps a path from being read as an option or another protocol.
        f"file:{path}",
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "f32le",
        "-c:a",
        "pcm_f32le",
        "pipe:1",
    ]
    try:
        proc = subprocess.run(argv, capture_output=True, check=False, timeout=DECODE_TIMEOUT_S)
    except OSError as exc:  # ffmpeg missing or not executable
        raise KeyDetectionError(f"decode failed: can't run ffmpeg ({exc})") from exc
    except subprocess.TimeoutExpired as exc:
        raise KeyDetectionError(f"decode timed out after {DECODE_TIMEOUT_S:g} s") from exc
    if proc.returncode != 0:
        lines = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        reason = lines[-1][:200] if lines else "no error output"
        raise KeyDetectionError(f"decode failed (ffmpeg exit {proc.returncode}): {reason}")
    samples = np.frombuffer(proc.stdout, dtype="<f4").astype(np.float32, copy=False)
    if samples.size == 0:
        raise KeyDetectionError("decode produced no audio")
    return samples, SAMPLE_RATE


def detect_key_from_samples(y: npt.ArrayLike, sr: int) -> KeyResult:
    """Detect the key of mono samples `y` at sample rate `sr`. Pure: no I/O.

    Raises KeyDetectionError for audio that is too short, silent, non-finite, or without
    tonal content, and ValueError for a non-mono array or a sample rate under 16 kHz.
    """
    import numpy as np

    samples = np.asarray(y, dtype=np.float32)
    if samples.ndim != 1:
        raise ValueError(f"expected mono 1-D samples, got shape {samples.shape}")
    if sr < 16_000:
        raise ValueError(f"sample rate {sr} Hz is too low for key detection")
    if samples.size < MIN_DURATION_S * sr:
        raise KeyDetectionError(f"audio is too short (< {MIN_DURATION_S:g} s)")
    if not np.isfinite(samples).all():
        raise KeyDetectionError("audio contains non-finite samples")
    if float(np.linalg.norm(samples)) / math.sqrt(samples.size) < SILENCE_RMS:
        raise KeyDetectionError("audio is silent")

    profile, tuning = _pitch_class_profile(samples, sr)
    probs = _confidences(_correlations(profile))
    ranked: list[KeyCandidate] = []
    for i in np.argsort(-probs, kind="stable")[: 1 + N_ALTERNATES]:
        tonic, mode = CANDIDATES[i]
        ranked.append(KeyCandidate(tonic, mode, round(float(probs[i]), 2)))
    best, *alternates = ranked
    return KeyResult(
        tonic=best.tonic,
        mode=best.mode,
        confidence=best.confidence,
        alternates=tuple(alternates),
        tuning_cents=max(-50, min(50, round(tuning * 100))),
    )


def warm_up() -> None:
    """Import librosa and compile its numba code now rather than in the first job.

    That one-off cost is ~2 s (numba cache warm) to ~3.5 s (cold) per process at
    --cpus=1, on top of the first detection. Blocking: call it via `asyncio.to_thread`,
    e.g. from the worker's startup hook. Optional; detection works without it.
    """
    import numpy as np

    t = np.arange(round(MIN_DURATION_S * SAMPLE_RATE)) / SAMPLE_RATE
    detect_key_from_samples(0.5 * np.sin(2 * np.pi * 440.0 * t), SAMPLE_RATE)


# --------------------------------------------------------------------------- internals


def _librosa() -> Any:
    """Import librosa on first use; it pulls in numba, whose JIT dominates import time.

    numba caches compiled code next to librosa's source, which the production image's
    non-root user can't write (root-owned venv, no home directory). Point NUMBA_CACHE_DIR
    at the temp dir unless the environment already sets it. numba reads it once, at import.
    """
    os.environ.setdefault("NUMBA_CACHE_DIR", os.path.join(tempfile.gettempdir(), "numba-cache"))
    import librosa

    return librosa


def _pitch_class_profile(
    y: npt.NDArray[np.float32], sr: int
) -> tuple[npt.NDArray[np.float64], float]:
    """(12-bin pitch-class profile, tuning offset in semitones in [-0.5, 0.5)).

    Raises KeyDetectionError if the audio has no pitched content (see `_salience`).
    """
    import numpy as np

    librosa = _librosa()
    if HARMONIC_SEPARATION:
        y = librosa.effects.harmonic(y)
    # In fractions of a semitone (bins_per_octave=12), so tuning_cents = round(100 * tuning).
    tuning = float(
        librosa.estimate_tuning(y=y, sr=sr, bins_per_octave=12, hop_length=TUNING_HOP_LENGTH)
    )
    # librosa's `tuning` is in fractions of one CQT bin, and a bin here is 1/BINS_PER_OCTAVE
    # of an octave, so the semitone offset is scaled by BINS_PER_OCTAVE / 12.
    cqt = np.abs(
        librosa.cqt(
            y,
            sr=sr,
            hop_length=HOP_LENGTH,
            fmin=FMIN_HZ,
            n_bins=N_OCTAVES * BINS_PER_OCTAVE,
            bins_per_octave=BINS_PER_OCTAVE,
            tuning=tuning * BINS_PER_OCTAVE / 12,
        )
    )
    peak = cqt.max(axis=0)
    cqt = cqt[:, peak >= FRAME_GATE * np.percentile(peak, 95)]
    if _salience(cqt) < MIN_SALIENCE:
        raise KeyDetectionError("audio has no clear tonal content")
    # Energy-weighted: no per-frame normalization, so quiet frames count for little. On 96
    # randomized synthetic songs this beat averaging max-normalized frames (82% vs 77% top-1).
    chroma = librosa.feature.chroma_cqt(
        C=cqt, fmin=FMIN_HZ, bins_per_octave=BINS_PER_OCTAVE, norm=None
    )
    profile: npt.NDArray[np.float64] = chroma.sum(axis=1, dtype=np.float64)
    return profile, tuning


def _salience(cqt: npt.NDArray[Any]) -> float:
    """CQT energy on the semitone grid over the energy +-1/3 semitone off it.

    With the CQT tuning-corrected, pitched notes concentrate on the grid (a harmonic tone
    gives ~1.7), while noise of any colour and drums spread evenly across it (~1.0).
    """
    third = BINS_PER_OCTAVE // 12
    per_bin = cqt.sum(axis=1).reshape(-1, 12, third)
    centre = float(per_bin[..., 0].sum())
    off = float(per_bin[..., 1:].sum()) / (third - 1)
    return centre / off if off > 0 else 0.0


def _correlations(profile: npt.NDArray[np.float64]) -> npt.NDArray[np.float64]:
    """Pearson r of `profile` with each of the 24 key profiles, in `CANDIDATES` order."""
    import numpy as np

    base = np.array([KK_MAJOR, KK_MINOR])
    # Row 12*m + t is profile m rotated so that its tonic sits on pitch class t.
    keys = np.stack([np.roll(base[m], t) for m in range(2) for t in range(12)])
    keys = (keys - keys.mean(axis=1, keepdims=True)) / keys.std(axis=1, keepdims=True)
    std = profile.std()
    if std == 0:
        raise KeyDetectionError("audio has no clear tonal content")
    z = (profile - profile.mean()) / std
    r: npt.NDArray[np.float64] = keys @ z / len(z)
    return r


def _confidences(r: npt.NDArray[np.float64]) -> npt.NDArray[np.float64]:
    """Softmax of the correlations divided by `SOFTMAX_TEMPERATURE`."""
    import numpy as np

    logits = r / SOFTMAX_TEMPERATURE
    e = np.exp(logits - logits.max())
    p: npt.NDArray[np.float64] = e / e.sum()
    return p

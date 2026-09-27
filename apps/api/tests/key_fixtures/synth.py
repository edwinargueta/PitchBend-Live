"""Deterministic synthetic music for the key-detection tests and benchmark.

Everything is generated with numpy at 22,050 Hz, mono float32. Notes are harmonic tones
(6 partials, 1/k amplitudes) with a short attack/release, so chroma looks like a real
instrument's without any committed audio files. Pitch classes follow
`pitchbend_live.audio.key_detection.PITCH_CLASSES` (0 = C).
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
import numpy.typing as npt

from pitchbend_live.audio.key_detection import PITCH_CLASSES, Mode

SR = 22_050
Audio = npt.NDArray[np.float32]

MAJOR_SCALE = (0, 2, 4, 5, 7, 9, 11)
NATURAL_MINOR_SCALE = (0, 2, 3, 5, 7, 8, 10)
HARMONIC_MINOR_SCALE = (0, 2, 3, 5, 7, 8, 11)

ALL_KEYS: tuple[tuple[str, Mode], ...] = tuple(
    (tonic, mode) for mode in ("major", "minor") for tonic in PITCH_CLASSES
)


def pc(tonic: str) -> int:
    return PITCH_CLASSES.index(tonic)


def relative_key(tonic: str, mode: Mode) -> tuple[str, Mode]:
    """C major <-> A minor."""
    if mode == "major":
        return PITCH_CLASSES[(pc(tonic) + 9) % 12], "minor"
    return PITCH_CLASSES[(pc(tonic) + 3) % 12], "major"


def midi_to_hz(midi: float, cents: float = 0.0) -> float:
    return float(440.0 * 2.0 ** ((midi - 69.0 + cents / 100.0) / 12.0))


def tone(
    midi: float, dur: float, *, cents: float = 0.0, amp: float = 0.15, n_partials: int = 6
) -> Audio:
    """One harmonic note: partial k at k*f0 with amplitude 1/k, 10 ms attack, 60 ms release."""
    n = round(dur * SR)
    t = np.arange(n) / SR
    f0 = midi_to_hz(midi, cents)
    sig = np.zeros(n)
    for k in range(1, n_partials + 1):
        if k * f0 < 0.45 * SR:
            sig += np.sin(2.0 * np.pi * k * f0 * t) / k
    env = np.minimum(1.0, t / 0.01) * np.minimum(1.0, (dur - t) / 0.06).clip(0.0)
    env *= np.exp(-0.4 * t)  # gentle piano-like decay
    return (amp * env * sig).astype(np.float32)


def chord(midis: Sequence[float], dur: float, *, cents: float = 0.0, amp: float = 0.12) -> Audio:
    return np.sum([tone(m, dur, cents=cents, amp=amp) for m in midis], axis=0).astype(np.float32)


def concat(parts: Sequence[Audio]) -> Audio:
    return np.concatenate(parts).astype(np.float32)


def scale_for(mode: Mode) -> tuple[int, ...]:
    return MAJOR_SCALE if mode == "major" else HARMONIC_MINOR_SCALE


def diatonic_triad(tonic_pc: int, mode: Mode, degree: int) -> tuple[int, int, int]:
    """Semitone offsets (root, third, fifth) from the tonic for scale degree 0..6.

    Minor keys use the harmonic minor, so V is major (the leading tone), as in common practice.
    """
    scale = scale_for(mode)
    notes = [scale[(degree + i) % 7] + 12 * ((degree + i) // 7) for i in (0, 2, 4)]
    return notes[0], notes[1], notes[2]


def voiced_chord(tonic_pc: int, mode: Mode, degree: int, dur: float, *, cents: float) -> Audio:
    """Bass root in octave 2, close triad around middle C."""
    root, third, fifth = diatonic_triad(tonic_pc, mode, degree)
    bass = 36 + (tonic_pc + root) % 12
    base = 55 + (tonic_pc + root - 55) % 12  # root in G3..F#4
    uppers = [base, base + (third - root), base + (fifth - root)]
    return chord([bass, *uppers], dur, cents=cents)


# ---------------------------------------------------------------- clear fixtures


def triad_fixture(tonic: str, mode: Mode, *, cents: float = 0.0, dur: float = 4.0) -> Audio:
    """The tonic triad, struck once per second, with the root in the bass."""
    t = pc(tonic)
    return concat([voiced_chord(t, mode, 0, 1.0, cents=cents) for _ in range(round(dur))])


def cadence_fixture(tonic: str, mode: Mode, *, cents: float = 0.0, chord_s: float = 1.0) -> Audio:
    """I-IV-V-I (major) or i-iv-V-i (minor), twice."""
    t = pc(tonic)
    degrees = (0, 3, 4, 0, 0, 3, 4, 0)
    return concat([voiced_chord(t, mode, d, chord_s, cents=cents) for d in degrees])


def scale_fixture(tonic: str, mode: Mode, *, cents: float = 0.0, note_s: float = 0.3) -> Audio:
    """One octave up and back down, ending on a held tonic.

    Minor goes up the harmonic minor and down the natural minor.
    """
    t = pc(tonic)
    base = 60 + t if t < 7 else 48 + t  # tonic in C4..F#4 or G3..B3
    up = scale_for(mode)
    down = MAJOR_SCALE if mode == "major" else NATURAL_MINOR_SCALE
    melody = [*up, 12, *reversed(down)]
    parts = [tone(base + s, note_s, cents=cents) for s in melody]
    parts.append(tone(base, 4 * note_s, cents=cents))
    return concat(parts)


FIXTURE_KINDS = {"triad": triad_fixture, "cadence": cadence_fixture, "scale": scale_fixture}


# ---------------------------------------------------------------- noise and drums


def white_noise(dur: float, *, seed: int = 0, amp: float = 0.1) -> Audio:
    rng = np.random.default_rng(seed)
    return (amp * rng.standard_normal(round(dur * SR))).astype(np.float32)


def colored_noise(dur: float, exponent: float, *, seed: int = 0, amp: float = 0.1) -> Audio:
    """Power spectrum ~ 1/f**exponent: 1 = pink, 2 = brown."""
    rng = np.random.default_rng(seed)
    n = round(dur * SR)
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1.0 / SR)
    f[0] = f[1]
    y = np.fft.irfft(spec / f ** (exponent / 2.0), n)
    return (amp * y / np.std(y)).astype(np.float32)


def drums(dur: float, *, bpm: float = 100.0, seed: int = 0, amp: float = 0.3) -> Audio:
    """Kick on 1 and 3, snare on 2 and 4, hi-hat eighths: broadband, no pitch class."""
    rng = np.random.default_rng(seed)
    n = round(dur * SR)
    out = np.zeros(n)
    beat = round(60.0 / bpm * SR)
    kick_t = np.arange(round(0.25 * SR)) / SR
    # Pitch sweeps 150 -> 50 Hz: phase = 2*pi * integral of (50 + 100 * exp(-t / 30 ms)).
    kick = np.sin(2 * np.pi * (50 * kick_t + 3.0 * (1 - np.exp(-kick_t / 0.03))))
    kick *= np.exp(-kick_t / 0.08)
    snare = rng.standard_normal(round(0.15 * SR)) * np.exp(-np.arange(round(0.15 * SR)) / 900)
    hat = np.diff(rng.standard_normal(round(0.04 * SR) + 1)) * np.exp(
        -np.arange(round(0.04 * SR)) / 150
    )
    for i, start in enumerate(range(0, n, beat // 2)):
        hits = [0.3 * hat]
        if i % 4 == 0:
            hits.append(kick)
        elif i % 4 == 2:
            hits.append(0.6 * snare)
        for h in hits:
            end = min(n, start + len(h))
            out[start:end] += h[: end - start]
    return (amp * out / np.max(np.abs(out))).astype(np.float32)


def mix(*signals: Audio) -> Audio:
    n = min(len(s) for s in signals)
    return np.sum([s[:n] for s in signals], axis=0).astype(np.float32)


def at_snr(signal: Audio, noise: Audio, snr_db: float) -> Audio:
    """`signal` plus `noise` scaled to the given signal-to-noise ratio."""
    n = min(len(signal), len(noise))
    s, z = signal[:n], noise[:n]
    gain = np.sqrt(np.mean(s**2) / (np.mean(z**2) * 10 ** (snr_db / 10)))
    return (s + gain * z).astype(np.float32)


# ---------------------------------------------------------------- random songs


def random_song(
    rng: np.random.Generator,
    tonic: str,
    mode: Mode,
    *,
    dur: float = 12.0,
    cents: float = 0.0,
    snr_db: float | None = None,
    with_drums: bool = False,
    framed: bool = True,
) -> Audio:
    """A random diatonic progression with a melody on top: harder than the clear fixtures.

    Chords are drawn with common-practice weights (I, IV, V, vi most likely) and last
    0.5-2 s; if `framed`, the song starts and ends on the tonic. The melody is a random walk
    on the scale.
    """
    t = pc(tonic)
    weights = np.array([0.30, 0.08, 0.05, 0.17, 0.20, 0.15, 0.05])
    parts: list[Audio] = []
    total = 0.0
    degree = 0 if framed else int(rng.choice(7, p=weights))
    while total < dur:
        chord_s = float(rng.choice([0.5, 1.0, 1.0, 2.0]))
        harmony = voiced_chord(t, mode, degree, chord_s, cents=cents)
        scale = scale_for(mode)
        if mode == "minor" and rng.random() < 0.5:
            scale = NATURAL_MINOR_SCALE
        note_s = chord_s / int(rng.choice([1, 2, 4]))
        step = int(rng.integers(0, 7))
        melody = []
        for _ in range(round(chord_s / note_s)):
            step = int(np.clip(step + rng.integers(-2, 3), 0, 13))
            midi = 60 + t + scale[step % 7] + 12 * (step // 7)
            melody.append(tone(midi, note_s, cents=cents, amp=0.1))
        parts.append(mix(harmony, concat(melody)))
        total += chord_s
        remaining = dur - total
        degree = 0 if framed and remaining <= 2.0 else int(rng.choice(7, p=weights))
    song = concat(parts)
    if with_drums:
        song = mix(song, drums(len(song) / SR, seed=int(rng.integers(1 << 31))))
    if snr_db is not None:
        song = at_snr(
            song, colored_noise(len(song) / SR, 1.0, seed=int(rng.integers(1 << 31))), snr_db
        )
    return song

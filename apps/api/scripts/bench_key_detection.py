"""Benchmark and calibrate key detection (ARCHITECTURE.md §10 A5).

Run from apps/api, ideally in the api image limited like the production worker (§3.6):

    docker run --rm --cpus=1 --memory=2g -v "$PWD:/app" -w /app keyshift-api:dev \\
        uv run python scripts/bench_key_detection.py time [--harmonic]
    uv run python scripts/bench_key_detection.py calibrate

`time` encodes a synthetic 4-minute song to AAC/m4a (like the pipeline's media files) and
times `detect_key` on it: the first call in the process (librosa import plus numba JIT or
cache load) and then steady-state repeats, split into decode and analysis.

`calibrate` fits `SOFTMAX_TEMPERATURE` by temperature scaling: on a seeded set of randomized
synthetic songs (noise, drums, detuning, progressions that may not start or end on the
tonic), it picks the temperature minimizing the mean negative log-likelihood of the true key.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))

from key_fixtures import synth

from keyshift.audio import key_detection as kd


def encode_m4a(y: synth.Audio, path: Path) -> None:
    """Write `y` as AAC in .m4a, as the ingest pipeline stores playback audio (D8)."""
    argv = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "f32le", "-ar"]
    argv += [str(synth.SR), "-ac", "1", "-i", "pipe:0", "-c:a", "aac", "-b:a", "192k", str(path)]
    subprocess.run(argv, input=y.astype("<f4").tobytes(), check=True)


def bench_time(harmonic: bool, repeats: int) -> None:
    kd.HARMONIC_SEPARATION = harmonic
    rng = np.random.default_rng(240)
    y = synth.random_song(rng, "G", "major", dur=240.0, cents=-12, snr_db=20, with_drums=True)
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "song.m4a"
        encode_m4a(y, path)
        print(f"4-minute song, harmonic separation {'on' if harmonic else 'off'}")
        for i in range(1 + repeats):
            t0 = time.perf_counter()
            samples, sr = kd.decode(path)
            t1 = time.perf_counter()
            result = kd.detect_key_from_samples(samples, sr)
            t2 = time.perf_counter()
            label = "first call" if i == 0 else f"repeat {i}"
            print(
                f"  {label:10s} total {t2 - t0:5.2f} s  (decode {t1 - t0:4.2f} s, "
                f"analysis {t2 - t1:5.2f} s)  -> {result.tonic} {result.mode} "
                f"{result.confidence:.2f}, tuning {result.tuning_cents:+d} c"
            )


def calibrate(reps: int, seed: int) -> None:
    rng = np.random.default_rng(seed)
    corr, truth = [], []
    for _ in range(reps):
        for tonic, mode in synth.ALL_KEYS:
            y = synth.random_song(
                rng,
                tonic,
                mode,
                dur=float(rng.uniform(8, 20)),
                cents=float(rng.uniform(-30, 30)),
                snr_db=[None, 20.0, 10.0, 5.0, 0.0][int(rng.integers(5))],
                with_drums=bool(rng.random() < 0.5),
                framed=bool(rng.random() < 0.5),
            )
            profile, _ = kd._pitch_class_profile(y, synth.SR)
            corr.append(kd._correlations(profile))
            truth.append(kd.CANDIDATES.index((tonic, mode)))
    r, t = np.array(corr), np.array(truth)
    idx = np.arange(len(t))

    def nll(temp: float) -> float:
        logits = r / temp
        logits -= logits.max(axis=1, keepdims=True)
        logp = logits - np.log(np.exp(logits).sum(axis=1, keepdims=True))
        return float(-logp[idx, t].mean())

    temps = np.round(np.arange(0.02, 0.301, 0.005), 3)
    losses = [nll(x) for x in temps]
    best = float(temps[int(np.argmin(losses))])
    top = r.argmax(axis=1)
    rel = np.array([kd.CANDIDATES.index(synth.relative_key(*kd.CANDIDATES[i])) for i in t])
    top3 = np.argsort(-r, axis=1)[:, :3]
    in_top3 = np.mean([t[i] in top3[i] for i in idx])
    print(f"{len(t)} songs: top-1 {np.mean(top == t):.0%}, top-3 {in_top3:.0%}")
    print(f"relative key ranked first: {np.mean(top == rel):.0%}")
    for temp in sorted({0.05, best, kd.SOFTMAX_TEMPERATURE, 0.12}):
        p = np.exp((r - r.max(axis=1, keepdims=True)) / temp)
        p /= p.sum(axis=1, keepdims=True)
        print(f"  T={temp:.3f}: NLL {nll(temp):.3f}, mean top confidence {p.max(1).mean():.2f}")
    print(f"NLL-optimal temperature: {best:.3f} (module uses {kd.SOFTMAX_TEMPERATURE})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("time", help="time detect_key on 4 minutes of AAC audio")
    t.add_argument("--harmonic", action="store_true", help="enable harmonic separation")
    t.add_argument("--repeats", type=int, default=3)
    c = sub.add_parser("calibrate", help="fit the softmax temperature")
    c.add_argument("--reps", type=int, default=8, help="songs per key")
    c.add_argument("--seed", type=int, default=2026)
    args = parser.parse_args()
    if args.cmd == "time":
        bench_time(args.harmonic, args.repeats)
    else:
        calibrate(args.reps, args.seed)


if __name__ == "__main__":
    main()

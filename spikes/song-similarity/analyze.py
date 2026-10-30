#!/usr/bin/env python3
"""Compute opening/closing audio embeddings for the songs in an Alcantara export.

Input : songs-to-analyze.json   (Radio desk > Song similarity > Export songs)
Output: embeddings.json         (Radio desk > Song similarity > Upload embeddings)

Model : Discogs-EffNet (discogs-effnet-bs64-1), Essentia, CC BY-NC-SA 4.0.
Preprocessing is Essentia's own: MonoLoader at 16 kHz and the model's built-in
mel front end (TensorflowPredictEffnetDiscogs). Nothing is reimplemented here.

The script needs no database access and no Alcantara credentials. It is
resumable: rerun the same command and finished songs are skipped.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

import numpy as np

MODEL = {"name": "discogs-effnet-bs64-1", "version": "1", "license": "CC BY-NC-SA 4.0"}
MODEL_URL = "https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb"
SAMPLE_RATE = 16000
EMBEDDING_OUTPUT = "PartitionedCall:1"  # embeddings output, per Essentia's model docs
DIMENSION = 1280
SILENCE_DB = -50.0
FRAME_SECONDS = 0.05
MIN_AUDIO_SECONDS = 10.0
DECIMALS = 6


def l2_normalize(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    if not norm > 0:
        raise ValueError("zero embedding")
    return vector / norm


def trim_silence(audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Drops leading and trailing frames quieter than SILENCE_DB (re full scale)."""
    frame = max(1, int(FRAME_SECONDS * sample_rate))
    count = len(audio) // frame
    if count == 0:
        return audio
    frames = audio[: count * frame].reshape(count, frame)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    db = 20.0 * np.log10(np.maximum(rms, 1e-10))
    loud = np.flatnonzero(db > SILENCE_DB)
    if loud.size == 0:
        return audio[:0]
    return audio[loud[0] * frame : (loud[-1] + 1) * frame]


def windows(audio: np.ndarray, window_seconds: int, sample_rate: int = SAMPLE_RATE):
    size = window_seconds * sample_rate
    if len(audio) < MIN_AUDIO_SECONDS * sample_rate:
        raise ValueError(f"audio shorter than {MIN_AUDIO_SECONDS:.0f}s after trimming silence")
    return audio[:size], audio[-size:]


def pool(frame_embeddings: np.ndarray) -> list[float]:
    """Mean-pool over time, then L2-normalize."""
    if frame_embeddings.ndim != 2 or frame_embeddings.shape[1] != DIMENSION:
        raise ValueError(f"unexpected embedding shape {frame_embeddings.shape}")
    vector = l2_normalize(frame_embeddings.mean(axis=0))
    return [round(float(v), DECIMALS) for v in vector]


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, target: Path) -> None:
    with urllib.request.urlopen(url, timeout=120) as response, target.open("wb") as out:
        while chunk := response.read(1 << 20):
            out.write(chunk)


def load_model(model_path: Path):
    from essentia.standard import TensorflowPredictEffnetDiscogs

    return TensorflowPredictEffnetDiscogs(
        graphFilename=str(model_path), output=EMBEDDING_OUTPUT
    )


def embed(model, audio_path: Path, window_seconds: int) -> tuple[list[float], list[float]]:
    from essentia.standard import MonoLoader

    audio = MonoLoader(filename=str(audio_path), sampleRate=SAMPLE_RATE, resampleQuality=4)()
    opening, closing = windows(trim_silence(audio), window_seconds)
    return pool(model(opening)), pool(model(closing))


def write_atomic(path: Path, payload: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w") as handle:
        json.dump(payload, handle)
    os.replace(tmp, path)


def ensure_model(path: Path) -> Path:
    if not path.exists():
        print(f"downloading model to {path} ...", file=sys.stderr)
        download(MODEL_URL, path)
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("export", type=Path, help="songs-to-analyze.json")
    parser.add_argument("-o", "--output", type=Path, default=Path("embeddings.json"))
    parser.add_argument("--window", type=int, help="seconds per window (default: the export's)")
    parser.add_argument("--model", type=Path, default=Path("discogs-effnet-bs64-1.pb"))
    args = parser.parse_args()

    export = json.loads(args.export.read_text())
    if export.get("schema") != 1 or export.get("model") != MODEL:
        print("export does not match this script's model", file=sys.stderr)
        return 2
    window = args.window or export["windowSeconds"]
    if window != export["windowSeconds"]:
        print(f"warning: window {window}s differs from the station's {export['windowSeconds']}s; "
              "upload will store it under that window", file=sys.stderr)

    result = {"schema": 1, "model": MODEL, "windowSeconds": window, "songs": [], "failures": []}
    if args.output.exists():
        previous = json.loads(args.output.read_text())
        if previous.get("model") == MODEL and previous.get("windowSeconds") == window:
            result["songs"] = previous.get("songs", [])
        else:
            print("existing output uses another model/window; starting fresh", file=sys.stderr)
    done = {song["songId"] for song in result["songs"]}

    model = None
    songs = export["songs"]
    for index, song in enumerate(songs, 1):
        label = f"[{index}/{len(songs)}] {song['songId']} {song['artist']} - {song['title']}"
        if song["songId"] in done:
            print(f"{label}: already in output, skipped")
            continue
        try:
            with tempfile.TemporaryDirectory() as workdir:
                suffix = Path(song["audioUrl"].split("?")[0]).suffix or ".audio"
                audio_path = Path(workdir) / f"song{suffix}"
                download(song["audioUrl"], audio_path)
                digest = sha256_of(audio_path)
                if song.get("existingAudioSha256") == digest:
                    print(f"{label}: unchanged on the server, skipped")
                    continue
                if model is None:
                    model = load_model(ensure_model(args.model))
                opening, closing = embed(model, audio_path, window)
            result["songs"].append(
                {"songId": song["songId"], "audioSha256": digest, "opening": opening, "closing": closing}
            )
            print(f"{label}: ok")
        except Exception as error:  # report per song, keep going
            result["failures"].append({"songId": song["songId"], "reason": str(error)[:300]})
            print(f"{label}: FAILED {error}", file=sys.stderr)
        write_atomic(args.output, result)

    write_atomic(args.output, result)
    print(f"done: {len(result['songs'])} embedded, {len(result['failures'])} failed -> {args.output}")
    return 1 if result["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())

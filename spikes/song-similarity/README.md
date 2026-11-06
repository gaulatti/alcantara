# Song similarity: offline analysis

`analyze.py` computes the opening and closing embeddings that Alcántara's
similarity picker compares (see `docs/song-similarity.md`). It runs on your own
computer, needs no Alcántara credentials and no database access, and is
resumable.

Model: Discogs-EffNet `discogs-effnet-bs64-1` (Essentia), CC BY-NC-SA 4.0.

## Setup

Use a Python version that has an `essentia-tensorflow` wheel for your platform.
The newest PyPI release (`2.1b6.dev1438`) ships wheels for Python 3.14 on macOS
(arm64 and x86_64) and Linux x86_64 only; for another Python or platform check
PyPI for a matching release first. `analyze.py` itself has not been run against
Essentia yet.

```bash
cd spikes/song-similarity
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

The 18 MB model is downloaded on first use next to the script
(`discogs-effnet-bs64-1.pb`).

## Run

1. In Alcántara, Radio distribution > Song similarity > **Export songs to
   analyze** and save `songs-to-analyze.json` here.
2. Analyze:

```bash
python analyze.py songs-to-analyze.json -o embeddings.json
```

3. In the same panel, **Upload embeddings.json**.

Per song it downloads the audio, hashes it (SHA-256), loads it mono at 16 kHz,
trims leading and trailing silence (-50 dBFS), embeds the first and last N
seconds (N = the station's window, default 30), mean-pools over time and
L2-normalizes. Songs whose hash is unchanged on the server are skipped; songs
already in `embeddings.json` are skipped, so rerunning continues where it
stopped. Failures (download, too short, decode) are listed per song in
`embeddings.json` under `failures` and printed; the batch continues, and the
exit code is 1 if any failed.

## Tests

The pooling, silence trimming and windowing helpers are tested without
Essentia:

```bash
pip install numpy && python -m unittest
```

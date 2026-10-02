# Trackback

Trackback is a local rehearsal backing-track player. Import a song, split it into stems, mute or reduce instruments, slow it down, and loop the part you want to practice.

It is deliberately **not a DAW**.

## Architecture

Trackback is a normal browser application backed by one localhost service:

```text
Browser (React/Vite)
       |
       | HTTP commands + WebSocket state
       v
Trackback API :4317
       |
       +-- library and import jobs
       +-- source repositories
       |     +-- local file
       |     +-- direct HTTP(S) audio
       |     +-- spotDL (Spotify URL or artist/title query)
       |
       +-- audio-separator
       +-- authoritative playback/mixer state
       |
       v
Browser audio playback
```

There is no Electron layer. Every command that exists in the UI goes through the same localhost API that future agents will use.

## Development

Requirements:

- Node.js 24+
- npm
- FFmpeg
- Python environment for optional song import/separation tools

Install JavaScript dependencies:

```bash
npm install
```

For a CPU-only development machine:

```bash
python -m venv .venv
source .venv/bin/activate
pip install "audio-separator[cpu]" spotdl
audio-separator --env_info
spotdl --version
```

GPU is not required. The default six-stem model is `htdemucs_6s.yaml`. On CPU it will be slower, but the rest of Trackback works normally while separation runs as a background job.

To force the separator process to hide any CUDA devices:

```bash
export TRACKBACK_SEPARATOR_DEVICE=cpu
```

Optional executable/model overrides:

```bash
export TRACKBACK_AUDIO_SEPARATOR=/path/to/audio-separator
export TRACKBACK_SPOTDL=/path/to/spotdl
export TRACKBACK_SEPARATOR_MODEL=htdemucs_6s.yaml
```

Start development mode:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

The API runs on:

```text
http://127.0.0.1:4317
```

Build the web UI and run everything from the API server:

```bash
npm run build
npm start
```

Then open `http://127.0.0.1:4317`.

By default Trackback stores its library under:

```text
~/.local/share/trackback
```

Override it with `TRACKBACK_DATA_DIR`.

## Source repositories

Import is intentionally provider-independent. The first repositories are:

### Local file

Browser:

```http
POST /api/import/upload?autoSeparate=true
X-Filename: encoded-file-name.flac

<raw file bytes>
```

Agent/local API:

```http
POST /api/import/path
Content-Type: application/json

{
  "path": "/music/song.flac",
  "autoSeparate": true
}
```

### Direct HTTP(S) audio

```http
POST /api/import
Content-Type: application/json

{
  "sourceRepositoryId": "http",
  "sourceRef": "https://example.org/song.flac",
  "autoSeparate": true
}
```

### spotDL

The spotDL repository accepts either a Spotify track URL or a text query:

```http
POST /api/import
Content-Type: application/json

{
  "sourceRepositoryId": "spotdl",
  "sourceRef": "Ramones - KKK Took My Baby Away",
  "autoSeparate": true
}
```

or:

```json
{
  "sourceRepositoryId": "spotdl",
  "sourceRef": "https://open.spotify.com/track/...",
  "autoSeparate": true
}
```

spotDL identifies the track from Spotify metadata and resolves downloadable audio from its supported sources. The imported file is cached in the Trackback library before stem separation.

The first implementation intentionally accepts one track per import job.

List available repositories:

```http
GET /api/sources
```

## Library and jobs

```http
GET /api/state
GET /api/library
WS  /events

POST /api/library/:songId/open
POST /api/library/:songId/separate
```

Import jobs move through:

```text
queued -> importing -> separating -> ready
                           |
                           -> error
```

Set `autoSeparate: false` to test import and playback without waiting for CPU stem separation.

## Playback API

```http
POST /api/playback/play
POST /api/playback/pause

POST /api/playback/seek
{ "positionSeconds": 42.5 }

POST /api/playback/speed
{ "speed": 0.8 }

POST /api/playback/loop
{ "startSeconds": 4.2, "endSeconds": 18.7 }

POST /api/playback/loop
{ "startSeconds": null, "endSeconds": null }
```

Mixer:

```http
PATCH /api/stems/bass
{ "volume": 0 }

PATCH /api/stems/guitar
{ "volume": 0.35 }

PATCH /api/stems/vocals
{ "muted": true }

PATCH /api/stems/drums
{ "solo": true }
```

Independent pitch is reserved in the API but is not applied by the current browser transport yet:

```http
POST /api/playback/pitch
{ "semitones": -2 }
```

## Next slices

1. Search/result selection instead of one-shot spotDL text resolution.
2. Waveform and named song sections.
3. BPM/beat detection and count-in.
4. Better time-stretch/pitch through AudioWorklet.
5. OpenAPI schema and semantic agent layer.

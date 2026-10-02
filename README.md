# Trackback

Trackback is a Linux desktop rehearsal player. It opens a song, separates it into stems, and lets you practice with selected instruments muted or reduced, at a slower speed, with A/B looping.

The first MVP is deliberately **not a DAW**.

## API-first architecture

```text
React renderer
      |
      | HTTP commands + WebSocket state
      v
localhost API :4317
      |
      +-- authoritative project/playback/mixer state
      +-- Electron file-dialog adapter
      +-- audio-separator process adapter
      |
      v
Renderer playback executor
```

Every user-visible command goes through the localhost API. The React UI does not call the playback or separation implementation directly. Future agents can therefore use the same API as the UI.

The current renderer executes audio with Chromium media elements. Chromium preserves pitch when playback speed changes. This is an MVP transport implementation behind the API contract and can later be replaced by AudioWorklet/SoundTouch or a native engine.

## MVP

- Open WAV, FLAC, MP3, M4A, OGG, OPUS or AIFF.
- Play, pause and seek.
- Playback speed from 50% to 120% with pitch preservation.
- A/B loop.
- Six-stem separation: vocals, drums, bass, guitar, piano and other.
- Volume, mute and solo per stem.
- Persistent local state.
- REST command API and WebSocket state feed.

## Requirements

- Linux
- Node.js 24+
- npm
- Python environment with `audio-separator`
- FFmpeg as required by the separator stack

For NVIDIA/CUDA:

```bash
pip install "audio-separator[gpu]"
audio-separator --env_info
```

Trackback invokes `audio-separator` from `PATH`. To select another executable:

```bash
export TRACKBACK_AUDIO_SEPARATOR=/path/to/audio-separator
```

The MVP uses the Demucs six-stem model `htdemucs_6s.yaml`.

## Run

```bash
npm install
npm run dev
```

## API

The API binds only to `127.0.0.1:4317`.

### State

```http
GET /api/health
GET /api/state
WS  /events
```

### Open audio

The desktop UI calls:

```http
POST /api/dialog/open-audio
```

Agents normally call:

```http
POST /api/project/open
Content-Type: application/json

{ "path": "/music/song.flac" }
```

### Stem separation

```http
POST /api/separation/start
```

The call returns HTTP 202. Read progress and completion from `GET /api/state` or `WS /events`.

### Transport

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

The state and API already reserve independent pitch control:

```http
POST /api/playback/pitch
{ "semitones": -2 }
```

The MVP browser transport does not yet apply independent pitch shifting. The endpoint is present so the external API does not need to change when DSP is added.

### Mixer

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

This is intentionally close to future agent commands such as:

> Play the intro at 80%. Remove bass and turn the guitar down.

The semantic layer later only needs to resolve `intro` to a region and translate the request to API calls.

## Next slices

1. Waveform and named song sections.
2. Beat/BPM detection and count-in.
3. Independent pitch shift through AudioWorklet.
4. OpenAPI schema and generated client.
5. Semantic agent command layer above the low-level API.

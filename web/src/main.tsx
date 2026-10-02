import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

const API = location.port === '5173' ? 'http://127.0.0.1:4317' : location.origin;
const WS = location.port === '5173' ? 'ws://127.0.0.1:4317/events' : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`;

type StemId = 'original' | 'vocals' | 'drums' | 'bass' | 'guitar' | 'piano' | 'other';

interface StemState {
  id: StemId;
  name: string;
  volume: number;
  muted: boolean;
  solo: boolean;
}

interface LibrarySong {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationSeconds: number;
  sourceRepositoryId: string;
  status: 'imported' | 'separating' | 'ready' | 'error';
  error: string | null;
  stems: StemState[];
}

interface ImportJob {
  id: string;
  sourceRepositoryId: string;
  sourceRef: string;
  status: 'queued' | 'importing' | 'separating' | 'ready' | 'error';
  message: string | null;
  error: string | null;
  songId: string | null;
}

interface SourceDescriptor {
  id: string;
  label: string;
  description: string;
  inputKind: 'file' | 'text';
  placeholder?: string;
}

interface AppState {
  library: {
    songs: LibrarySong[];
    jobs: ImportJob[];
  };
  project: null | {
    songId: string;
    title: string;
    durationSeconds: number;
    stems: StemState[];
  };
  playback: {
    playing: boolean;
    positionSeconds: number;
    speed: number;
    pitchSemitones: number;
    loopStartSeconds: number | null;
    loopEndSeconds: number | null;
  };
}

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

const commands = {
  state: () => request<AppState>('/api/state'),
  sources: () => request<SourceDescriptor[]>('/api/sources'),
  importRef: (sourceRepositoryId: string, sourceRef: string, autoSeparate: boolean) =>
    request<ImportJob>('/api/import', {
      method: 'POST',
      body: JSON.stringify({ sourceRepositoryId, sourceRef, autoSeparate })
    }),
  upload: async (file: File, autoSeparate: boolean) => {
    const response = await fetch(`${API}/api/import/upload?autoSeparate=${autoSeparate}`, {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(file.name) },
      body: file
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data as ImportJob;
  },
  openSong: (songId: string) => request<AppState>(`/api/library/${songId}/open`, { method: 'POST' }),
  separateSong: (songId: string) => request<{ accepted: boolean }>(`/api/library/${songId}/separate`, { method: 'POST' }),
  play: () => request<AppState>('/api/playback/play', { method: 'POST' }),
  pause: () => request<AppState>('/api/playback/pause', { method: 'POST' }),
  seek: (positionSeconds: number) => request<AppState>('/api/playback/seek', {
    method: 'POST', body: JSON.stringify({ positionSeconds })
  }),
  speed: (speed: number) => request<AppState>('/api/playback/speed', {
    method: 'POST', body: JSON.stringify({ speed })
  }),
  loop: (startSeconds: number | null, endSeconds: number | null) => request<AppState>('/api/playback/loop', {
    method: 'POST', body: JSON.stringify({ startSeconds, endSeconds })
  }),
  stem: (stemId: StemId, patch: { volume?: number; muted?: boolean; solo?: boolean }) =>
    request<AppState>(`/api/stems/${stemId}`, { method: 'PATCH', body: JSON.stringify(patch) })
};

class StemPlayer {
  private songId: string | null = null;
  private elements = new Map<StemId, HTMLAudioElement>();
  private loopTimer: number | null = null;

  sync(state: AppState): void {
    const project = state.project;
    if (!project) {
      this.stopAll();
      this.songId = null;
      return;
    }

    if (project.songId !== this.songId) {
      this.stopAll();
      this.songId = project.songId;
    }

    const liveIds = new Set(project.stems.map(stem => stem.id));
    for (const [id, audio] of this.elements) {
      if (!liveIds.has(id)) {
        audio.pause();
        this.elements.delete(id);
      }
    }

    for (const stem of project.stems) {
      if (!this.elements.has(stem.id)) {
        const audio = new Audio(`${API}/media/${stem.id}`);
        audio.preload = 'auto';
        audio.preservesPitch = true;
        this.elements.set(stem.id, audio);
      }
    }

    const anySolo = project.stems.some(stem => stem.solo);
    for (const stem of project.stems) {
      const audio = this.elements.get(stem.id)!;
      audio.volume = stem.volume;
      audio.muted = anySolo ? !stem.solo : stem.muted;
      audio.playbackRate = state.playback.speed;

      if (Math.abs(audio.currentTime - state.playback.positionSeconds) > 0.25) {
        try { audio.currentTime = state.playback.positionSeconds; } catch { /* metadata may still be loading */ }
      }

      if (state.playback.playing && audio.paused) {
        void audio.play().catch(() => undefined);
      } else if (!state.playback.playing && !audio.paused) {
        audio.pause();
      }
    }

    this.configureLoop(state);
  }

  private configureLoop(state: AppState): void {
    if (this.loopTimer !== null) window.clearInterval(this.loopTimer);

    const start = state.playback.loopStartSeconds;
    const end = state.playback.loopEndSeconds;
    if (start === null || end === null) {
      this.loopTimer = null;
      return;
    }

    this.loopTimer = window.setInterval(() => {
      const first = this.elements.values().next().value as HTMLAudioElement | undefined;
      if (!first || first.currentTime < end) return;
      for (const audio of this.elements.values()) audio.currentTime = start;
    }, 25);
  }

  private stopAll(): void {
    if (this.loopTimer !== null) window.clearInterval(this.loopTimer);
    this.loopTimer = null;
    for (const audio of this.elements.values()) audio.pause();
    this.elements.clear();
  }
}

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return '0:00';
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [sources, setSources] = useState<SourceDescriptor[]>([]);
  const [sourceId, setSourceId] = useState('spotdl');
  const [sourceRef, setSourceRef] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [autoSeparate, setAutoSeparate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const player = useMemo(() => new StemPlayer(), []);

  useEffect(() => {
    void Promise.all([commands.state(), commands.sources()])
      .then(([initial, availableSources]) => {
        setState(initial);
        setSources(availableSources);
        if (!availableSources.some(source => source.id === sourceId) && availableSources[0]) {
          setSourceId(availableSources[0].id);
        }
        player.sync(initial);
      })
      .catch(e => setError(String(e)));

    const socket = new WebSocket(WS);
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.type === 'state') {
        setState(message.state);
        player.sync(message.state);
      }
    };
    return () => socket.close();
  }, [player]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!state) return <main className="shell"><p>Connecting to Trackback API…</p></main>;

  const source = sources.find(candidate => candidate.id === sourceId);
  const project = state.project;
  const playback = state.playback;

  const startImport = async () => {
    if (source?.inputKind === 'file') {
      if (!file) throw new Error('Choose an audio file first');
      await commands.upload(file, autoSeparate);
      setFile(null);
      return;
    }
    if (!sourceRef.trim()) throw new Error('Enter a song, Spotify URL, or audio URL');
    await commands.importRef(sourceId, sourceRef.trim(), autoSeparate);
    setSourceRef('');
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Trackback</h1>
          <p className="subtitle">Rehearsal backing tracks, controlled through one local API</p>
        </div>
        <span className="api-badge">API :4317</span>
      </header>

      {error && <div className="error">{error}</div>}

      <section className="card import-card">
        <div className="section-title">
          <div>
            <h2>Import song</h2>
            <p>Choose where Trackback should get the source audio.</p>
          </div>
        </div>

        <div className="import-grid">
          <select value={sourceId} onChange={event => setSourceId(event.target.value)}>
            {sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>

          {source?.inputKind === 'file' ? (
            <input
              type="file"
              accept=".wav,.flac,.mp3,.m4a,.ogg,.opus,.aiff,.aif,audio/*"
              onChange={event => setFile(event.target.files?.[0] ?? null)}
            />
          ) : (
            <input
              type="text"
              value={sourceRef}
              placeholder={source?.placeholder ?? 'Source'}
              onChange={event => setSourceRef(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') void run(startImport);
              }}
            />
          )}

          <button onClick={() => void run(startImport)}>Import</button>
        </div>

        <div className="import-options">
          <label>
            <input
              type="checkbox"
              checked={autoSeparate}
              onChange={event => setAutoSeparate(event.target.checked)}
            />
            Split stems after import
          </label>
          <span>{source?.description}</span>
        </div>
      </section>

      {state.library.jobs.some(job => job.status !== 'ready') && (
        <section className="card">
          <h2>Import jobs</h2>
          <div className="jobs">
            {state.library.jobs.slice(0, 5).map(job => (
              <div className="job" key={job.id}>
                <strong>{job.sourceRef}</strong>
                <span>{job.status}</span>
                <small className={job.error ? 'job-error' : ''}>{job.error ?? job.message ?? ''}</small>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <div className="section-title">
          <div>
            <h2>Library</h2>
            <p>{state.library.songs.length} song{state.library.songs.length === 1 ? '' : 's'}</p>
          </div>
        </div>

        {state.library.songs.length === 0 ? (
          <div className="empty-library">Import a song to create the local Trackback library.</div>
        ) : (
          <div className="library">
            {state.library.songs.map(song => (
              <div className="library-row" key={song.id}>
                <div>
                  <strong>{song.title}</strong>
                  <span>{song.artist ?? song.album ?? song.sourceRepositoryId}</span>
                </div>
                <span className={`status status-${song.status}`}>{song.status}</span>
                <span>{formatTime(song.durationSeconds)}</span>
                <button onClick={() => void run(() => commands.openSong(song.id))}>
                  {project?.songId === song.id ? 'Loaded' : 'Open'}
                </button>
                {song.stems.length === 0 && song.status !== 'separating' && (
                  <button onClick={() => void run(() => commands.separateSong(song.id))}>Split</button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {project && (
        <>
          <section className="card song">
            <div>
              <h2>{project.title}</h2>
              <span>{formatTime(playback.positionSeconds)} / {formatTime(project.durationSeconds)}</span>
            </div>
            <input
              className="timeline"
              aria-label="Position"
              type="range"
              min={0}
              max={project.durationSeconds || 1}
              step={0.05}
              value={Math.min(playback.positionSeconds, project.durationSeconds || 1)}
              onChange={event => void run(() => commands.seek(Number(event.target.value)))}
            />
          </section>

          <section className="transport">
            <button className="play" onClick={() => void run(playback.playing ? commands.pause : commands.play)}>
              {playback.playing ? 'Pause' : 'Play'}
            </button>

            <label>
              Speed <strong>{Math.round(playback.speed * 100)}%</strong>
              <input
                type="range"
                min={0.5}
                max={1.2}
                step={0.05}
                value={playback.speed}
                onChange={event => void run(() => commands.speed(Number(event.target.value)))}
              />
            </label>

            <div className="loop">
              <button onClick={() => void run(() => commands.loop(playback.positionSeconds, playback.loopEndSeconds))}>
                Set A {playback.loopStartSeconds === null ? '' : formatTime(playback.loopStartSeconds)}
              </button>
              <button onClick={() => void run(() => commands.loop(playback.loopStartSeconds, playback.positionSeconds))}>
                Set B {playback.loopEndSeconds === null ? '' : formatTime(playback.loopEndSeconds)}
              </button>
              <button onClick={() => void run(() => commands.loop(null, null))}>Clear loop</button>
            </div>
          </section>

          <section className="mixer">
            {project.stems.map(stem => (
              <div className="stem" key={stem.id}>
                <div className="stem-title">{stem.name}</div>
                <input
                  aria-label={`${stem.name} volume`}
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={stem.volume}
                  onChange={event => void run(() => commands.stem(stem.id, { volume: Number(event.target.value) }))}
                />
                <span className="percent">{Math.round(stem.volume * 100)}%</span>
                <button
                  className={stem.muted ? 'active' : ''}
                  onClick={() => void run(() => commands.stem(stem.id, { muted: !stem.muted }))}
                >M</button>
                <button
                  className={stem.solo ? 'active' : ''}
                  onClick={() => void run(() => commands.stem(stem.id, { solo: !stem.solo }))}
                >S</button>
              </div>
            ))}
          </section>
        </>
      )}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);

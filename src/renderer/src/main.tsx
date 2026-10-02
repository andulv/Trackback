import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

const API = 'http://127.0.0.1:4317';

type StemId = 'original' | 'vocals' | 'drums' | 'bass' | 'guitar' | 'piano' | 'other';

interface StemState {
  id: StemId;
  name: string;
  volume: number;
  muted: boolean;
  solo: boolean;
}

interface AppState {
  project: null | {
    id: string;
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
  separation: {
    running: boolean;
    error: string | null;
    lastLogLine: string | null;
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
  openDialog: () => request<AppState | undefined>('/api/dialog/open-audio', { method: 'POST' }),
  separate: () => request<{ accepted: boolean }>('/api/separation/start', { method: 'POST' }),
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
  private projectId: string | null = null;
  private elements = new Map<StemId, HTMLAudioElement>();
  private loopTimer: number | null = null;

  sync(state: AppState): void {
    const project = state.project;
    if (!project) {
      this.stopAll();
      this.projectId = null;
      return;
    }

    if (project.id !== this.projectId) {
      this.stopAll();
      this.projectId = project.id;
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
        try { audio.currentTime = state.playback.positionSeconds; } catch { /* media metadata may still load */ }
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
  const [error, setError] = useState<string | null>(null);
  const player = useMemo(() => new StemPlayer(), []);

  useEffect(() => {
    void commands.state().then(initial => {
      setState(initial);
      player.sync(initial);
    }).catch(e => setError(String(e)));

    const socket = new WebSocket('ws://127.0.0.1:4317/events');
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

  const project = state.project;
  const playback = state.playback;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Trackback</h1>
          <p className="subtitle">API-first rehearsal player</p>
        </div>
        <div className="actions">
          <button onClick={() => void run(commands.openDialog)}>Open audio</button>
          <button disabled={!project || state.separation.running} onClick={() => void run(commands.separate)}>
            {state.separation.running ? 'Splitting…' : 'Split stems'}
          </button>
        </div>
      </header>

      {error && <div className="error">{error}</div>}
      {state.separation.error && <div className="error">{state.separation.error}</div>}

      {!project ? (
        <section className="empty">
          <h2>Open a song</h2>
          <p>Play the original immediately, then split it into six stems.</p>
        </section>
      ) : (
        <>
          <section className="song">
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

          <footer className="status">
            <span>API: 127.0.0.1:4317</span>
            <span>{state.separation.lastLogLine ?? 'Ready'}</span>
          </footer>
        </>
      )}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);

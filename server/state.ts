import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export type StemId = 'original' | 'vocals' | 'drums' | 'bass' | 'guitar' | 'piano' | 'other';
export type SongStatus = 'imported' | 'separating' | 'ready' | 'error';
export type ImportStatus = 'queued' | 'importing' | 'separating' | 'ready' | 'error';

export interface StemState {
  id: StemId;
  name: string;
  filePath: string;
  volume: number;
  muted: boolean;
  solo: boolean;
}

export interface LibrarySong {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationSeconds: number;
  sourceRepositoryId: string;
  sourceRef: string;
  sourcePath: string;
  stems: StemState[];
  status: SongStatus;
  error: string | null;
  importedAt: string;
}

export interface ImportJob {
  id: string;
  sourceRepositoryId: string;
  sourceRef: string;
  status: ImportStatus;
  message: string | null;
  error: string | null;
  songId: string | null;
  createdAt: string;
}

export interface ProjectState {
  songId: string;
  title: string;
  durationSeconds: number;
  stems: StemState[];
}

export interface AppState {
  library: {
    songs: LibrarySong[];
    jobs: ImportJob[];
  };
  project: ProjectState | null;
  playback: {
    playing: boolean;
    positionSeconds: number;
    speed: number;
    pitchSemitones: number;
    loopStartSeconds: number | null;
    loopEndSeconds: number | null;
  };
}

const freshState = (): AppState => ({
  library: { songs: [], jobs: [] },
  project: null,
  playback: {
    playing: false,
    positionSeconds: 0,
    speed: 1,
    pitchSemitones: 0,
    loopStartSeconds: null,
    loopEndSeconds: null
  }
});

export class StateStore extends EventEmitter {
  private state: AppState;
  private startedAtMs: number | null = null;

  constructor(private readonly storageFile: string) {
    super();
    this.state = this.load();
  }

  private load(): AppState {
    const base = freshState();
    try {
      if (!fs.existsSync(this.storageFile)) return base;
      const parsed = JSON.parse(fs.readFileSync(this.storageFile, 'utf8')) as Partial<AppState>;
      return {
        ...base,
        ...parsed,
        library: {
          songs: parsed.library?.songs ?? [],
          jobs: (parsed.library?.jobs ?? []).map(job => {
            if (job.status === 'queued' || job.status === 'importing' || job.status === 'separating') {
              return {
                ...job,
                status: 'error' as const,
                message: null,
                error: 'Interrupted by Trackback restart'
              };
            }
            return job;
          })
        },
        playback: {
          ...base.playback,
          ...(parsed.playback ?? {})
        }
      };
    } catch {
      return base;
    }
  }

  private currentPosition(now = Date.now()): number {
    const p = this.state.playback;
    let position = p.positionSeconds;

    if (p.playing && this.startedAtMs !== null) {
      position += ((now - this.startedAtMs) / 1000) * p.speed;
    }

    if (p.loopStartSeconds !== null && p.loopEndSeconds !== null && p.loopEndSeconds > p.loopStartSeconds) {
      const length = p.loopEndSeconds - p.loopStartSeconds;
      if (position >= p.loopEndSeconds) {
        position = p.loopStartSeconds + ((position - p.loopStartSeconds) % length);
      }
    }

    const duration = this.state.project?.durationSeconds ?? 0;
    if (duration > 0) position = Math.min(position, duration);
    return Math.max(position, 0);
  }

  snapshot(): AppState {
    return {
      ...this.state,
      library: {
        songs: [...this.state.library.songs],
        jobs: [...this.state.library.jobs]
      },
      playback: {
        ...this.state.playback,
        positionSeconds: this.currentPosition()
      }
    };
  }

  mutate(mutator: (state: AppState) => void): AppState {
    this.state.playback.positionSeconds = this.currentPosition();
    this.startedAtMs = this.state.playback.playing ? Date.now() : null;

    mutator(this.state);

    this.startedAtMs = this.state.playback.playing ? Date.now() : null;
    fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
    fs.writeFileSync(this.storageFile, JSON.stringify(this.snapshot(), null, 2));

    const snapshot = this.snapshot();
    this.emit('changed', snapshot);
    return snapshot;
  }

  openSong(songId: string): AppState {
    const song = this.state.library.songs.find(candidate => candidate.id === songId);
    if (!song) throw new Error('Song not found');

    const stems = song.stems.length > 0
      ? song.stems
      : [{
          id: 'original' as const,
          name: 'Original',
          filePath: song.sourcePath,
          volume: 1,
          muted: false,
          solo: false
        }];

    return this.mutate(state => {
      state.project = {
        songId: song.id,
        title: song.artist ? `${song.artist} — ${song.title}` : song.title,
        durationSeconds: song.durationSeconds,
        stems
      };
      state.playback.playing = false;
      state.playback.positionSeconds = 0;
      state.playback.loopStartSeconds = null;
      state.playback.loopEndSeconds = null;
    });
  }
}

import { app, BrowserWindow, dialog } from 'electron';
import cors from 'cors';
import express from 'express';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile } from 'music-metadata';
import { WebSocketServer } from 'ws';

const API_PORT = 4317;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type StemId = 'original' | 'vocals' | 'drums' | 'bass' | 'guitar' | 'piano' | 'other';

interface StemState {
  id: StemId;
  name: string;
  filePath: string;
  volume: number;
  muted: boolean;
  solo: boolean;
}

interface ProjectState {
  id: string;
  title: string;
  sourcePath: string;
  durationSeconds: number;
  stems: StemState[];
}

interface AppState {
  project: ProjectState | null;
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

const freshState = (): AppState => ({
  project: null,
  playback: {
    playing: false,
    positionSeconds: 0,
    speed: 1,
    pitchSemitones: 0,
    loopStartSeconds: null,
    loopEndSeconds: null
  },
  separation: {
    running: false,
    error: null,
    lastLogLine: null
  }
});

class StateStore extends EventEmitter {
  private state: AppState;
  private startedAtMs: number | null = null;

  constructor(private readonly storageFile: string) {
    super();
    this.state = this.load();
  }

  private load(): AppState {
    try {
      if (fs.existsSync(this.storageFile)) {
        return { ...freshState(), ...JSON.parse(fs.readFileSync(this.storageFile, 'utf8')) };
      }
    } catch {
      // A damaged state file must not prevent startup.
    }
    return freshState();
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

  replaceProject(project: ProjectState): AppState {
    return this.mutate(state => {
      state.project = project;
      state.playback.playing = false;
      state.playback.positionSeconds = 0;
      state.playback.loopStartSeconds = null;
      state.playback.loopEndSeconds = null;
      state.separation = { running: false, error: null, lastLogLine: null };
    });
  }
}

async function separateSixStems(
  inputPath: string,
  outputDir: string,
  onLog: (line: string) => void
): Promise<StemState[]> {
  fs.mkdirSync(outputDir, { recursive: true });

  const outputNames = JSON.stringify({
    Vocals: 'vocals',
    Drums: 'drums',
    Bass: 'bass',
    Guitar: 'guitar',
    Piano: 'piano',
    Other: 'other'
  });

  const args = [
    inputPath,
    '--model_filename', 'htdemucs_6s.yaml',
    '--output_format', 'FLAC',
    '--output_dir', outputDir,
    '--custom_output_names', outputNames
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.TRACKBACK_AUDIO_SEPARATOR ?? 'audio-separator', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const consume = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) onLog(line);
    };

    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', error => reject(new Error(
      `Could not start audio-separator: ${error.message}. Install it or set TRACKBACK_AUDIO_SEPARATOR.`
    )));
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`audio-separator exited with code ${code ?? 'unknown'}`));
    });
  });

  const ids: Exclude<StemId, 'original'>[] = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
  const files = fs.readdirSync(outputDir);

  return ids.map(id => {
    const file = files.find(name => {
      const lower = name.toLowerCase();
      return lower === `${id}.flac` || lower.startsWith(`${id}.`) || lower.startsWith(`${id}_`);
    });
    if (!file) throw new Error(`No output file was found for stem "${id}".`);
    return {
      id,
      name: id[0].toUpperCase() + id.slice(1),
      filePath: path.join(outputDir, file),
      volume: 1,
      muted: false,
      solo: false
    };
  });
}

async function startApiServer(
  store: StateStore,
  dataDir: string,
  selectAudioFile: () => Promise<string | null>
): Promise<http.Server> {
  const api = express();
  const server = http.createServer(api);
  const wss = new WebSocketServer({ server, path: '/events' });

  api.use(cors());
  api.use(express.json());

  const broadcast = () => {
    const payload = JSON.stringify({ type: 'state', state: store.snapshot() });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  };

  store.on('changed', broadcast);
  const ticker = setInterval(broadcast, 250);
  server.on('close', () => clearInterval(ticker));
  wss.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'state', state: store.snapshot() }));
  });

  api.get('/api/health', (_req, res) => res.json({ ok: true, apiVersion: 1 }));
  api.get('/api/state', (_req, res) => res.json(store.snapshot()));

  async function openProject(filePath: string): Promise<AppState> {
    const absolute = path.resolve(filePath);
    if (!fs.existsSync(absolute)) throw new Error(`File does not exist: ${absolute}`);

    const metadata = await parseFile(absolute, { duration: true });
    return store.replaceProject({
      id: crypto.randomUUID(),
      title: path.basename(absolute, path.extname(absolute)),
      sourcePath: absolute,
      durationSeconds: metadata.format.duration ?? 0,
      stems: [{
        id: 'original',
        name: 'Original',
        filePath: absolute,
        volume: 1,
        muted: false,
        solo: false
      }]
    });
  }

  api.post('/api/dialog/open-audio', async (_req, res) => {
    try {
      const selected = await selectAudioFile();
      if (!selected) return res.status(204).end();
      res.json(await openProject(selected));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.post('/api/project/open', async (req, res) => {
    try {
      if (typeof req.body?.path !== 'string') return res.status(400).json({ error: 'path is required' });
      res.json(await openProject(req.body.path));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.post('/api/separation/start', (_req, res) => {
    const project = store.snapshot().project;
    if (!project) return res.status(409).json({ error: 'No project is open' });
    if (store.snapshot().separation.running) return res.status(409).json({ error: 'Separation is already running' });

    const outputDir = path.join(dataDir, 'projects', project.id, 'stems');
    store.mutate(state => {
      state.separation.running = true;
      state.separation.error = null;
      state.separation.lastLogLine = 'Starting six-stem separation';
    });

    res.status(202).json({ accepted: true });

    void separateSixStems(project.sourcePath, outputDir, line => {
      store.mutate(state => { state.separation.lastLogLine = line; });
    }).then(stems => {
      store.mutate(state => {
        if (!state.project || state.project.id !== project.id) return;
        state.project.stems = stems;
        state.separation.running = false;
        state.separation.error = null;
        state.separation.lastLogLine = 'Separation complete';
      });
    }).catch(error => {
      store.mutate(state => {
        state.separation.running = false;
        state.separation.error = error instanceof Error ? error.message : String(error);
      });
    });
  });

  api.post('/api/playback/play', (_req, res) => {
    res.json(store.mutate(state => { state.playback.playing = true; }));
  });

  api.post('/api/playback/pause', (_req, res) => {
    res.json(store.mutate(state => { state.playback.playing = false; }));
  });

  api.post('/api/playback/seek', (req, res) => {
    const position = Number(req.body?.positionSeconds);
    if (!Number.isFinite(position)) return res.status(400).json({ error: 'positionSeconds must be a number' });
    res.json(store.mutate(state => {
      state.playback.positionSeconds = Math.max(0, Math.min(position, state.project?.durationSeconds ?? position));
    }));
  });

  api.post('/api/playback/speed', (req, res) => {
    const speed = Number(req.body?.speed);
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 1.5) {
      return res.status(400).json({ error: 'speed must be between 0.5 and 1.5' });
    }
    res.json(store.mutate(state => { state.playback.speed = speed; }));
  });

  api.post('/api/playback/pitch', (req, res) => {
    const semitones = Number(req.body?.semitones);
    if (!Number.isFinite(semitones) || semitones < -12 || semitones > 12) {
      return res.status(400).json({ error: 'semitones must be between -12 and 12' });
    }
    res.json(store.mutate(state => { state.playback.pitchSemitones = semitones; }));
  });

  api.post('/api/playback/loop', (req, res) => {
    const start = req.body?.startSeconds === null ? null : Number(req.body?.startSeconds);
    const end = req.body?.endSeconds === null ? null : Number(req.body?.endSeconds);

    if ((start !== null && !Number.isFinite(start)) || (end !== null && !Number.isFinite(end))) {
      return res.status(400).json({ error: 'Loop values must be numbers or null' });
    }
    if (start !== null && end !== null && end <= start) {
      return res.status(400).json({ error: 'Loop end must be after loop start' });
    }

    res.json(store.mutate(state => {
      state.playback.loopStartSeconds = start;
      state.playback.loopEndSeconds = end;
    }));
  });

  api.patch('/api/stems/:stemId', (req, res) => {
    let found = false;
    const stemId = req.params.stemId as StemId;
    const snapshot = store.mutate(state => {
      const stem = state.project?.stems.find(candidate => candidate.id === stemId);
      if (!stem) return;
      found = true;
      if (req.body.volume !== undefined) stem.volume = Math.max(0, Math.min(1, Number(req.body.volume)));
      if (req.body.muted !== undefined) stem.muted = Boolean(req.body.muted);
      if (req.body.solo !== undefined) stem.solo = Boolean(req.body.solo);
    });
    if (!found) return res.status(404).json({ error: 'Stem not found' });
    res.json(snapshot);
  });

  api.get('/media/:stemId', (req, res) => {
    const stem = store.snapshot().project?.stems.find(candidate => candidate.id === req.params.stemId);
    if (!stem || !fs.existsSync(stem.filePath)) return res.status(404).end();
    res.sendFile(stem.filePath);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(API_PORT, '127.0.0.1', () => resolve());
  });

  return server;
}

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  const store = new StateStore(path.join(dataDir, 'state.json'));

  await startApiServer(store, dataDir, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'mp3', 'm4a', 'ogg', 'opus', 'aiff'] }]
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

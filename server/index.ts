import cors from 'cors';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseFile } from 'music-metadata';
import { WebSocketServer } from 'ws';
import { separateSixStems } from './separator';
import { createSourceRepositories } from './sources';
import { StateStore, type ImportJob, type LibrarySong, type StemId } from './state';

const PORT = Number(process.env.TRACKBACK_PORT ?? 4317);
const DATA_DIR = process.env.TRACKBACK_DATA_DIR ?? path.join(os.homedir(), '.local', 'share', 'trackback');
const WEB_DIR = path.resolve(process.cwd(), 'dist-web');
const store = new StateStore(path.join(DATA_DIR, 'state.json'));
const repositories = createSourceRepositories();
const repositoryMap = new Map(repositories.map(repository => [repository.descriptor.id, repository]));

const api = express();
const server = http.createServer(api);
const wss = new WebSocketServer({ server, path: '/events' });

api.use(cors());
api.use(express.json({ limit: '1mb' }));

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

function setJob(jobId: string, patch: Partial<ImportJob>): void {
  store.mutate(state => {
    const job = state.library.jobs.find(candidate => candidate.id === jobId);
    if (job) Object.assign(job, patch);
  });
}

function addJob(sourceRepositoryId: string, sourceRef: string): ImportJob {
  const job: ImportJob = {
    id: crypto.randomUUID(),
    sourceRepositoryId,
    sourceRef,
    status: 'queued',
    message: 'Queued',
    error: null,
    songId: null,
    createdAt: new Date().toISOString()
  };
  store.mutate(state => {
    state.library.jobs.unshift(job);
    state.library.jobs = state.library.jobs.slice(0, 50);
  });
  return job;
}

async function runSeparation(songId: string, jobId?: string): Promise<void> {
  const song = store.snapshot().library.songs.find(candidate => candidate.id === songId);
  if (!song) throw new Error('Song not found');

  store.mutate(state => {
    const target = state.library.songs.find(candidate => candidate.id === songId);
    if (target) {
      target.status = 'separating';
      target.error = null;
    }
    const job = jobId ? state.library.jobs.find(candidate => candidate.id === jobId) : undefined;
    if (job) {
      job.status = 'separating';
      job.message = 'Separating stems';
    }
  });

  try {
    const stems = await separateSixStems(
      song.sourcePath,
      path.join(DATA_DIR, 'library', song.id, 'stems'),
      path.join(DATA_DIR, 'models'),
      line => {
        if (jobId) setJob(jobId, { message: line });
      }
    );

    store.mutate(state => {
      const target = state.library.songs.find(candidate => candidate.id === songId);
      if (target) {
        target.stems = stems;
        target.status = 'ready';
        target.error = null;
      }

      if (state.project?.songId === songId) {
        state.project.stems = stems;
      }

      const job = jobId ? state.library.jobs.find(candidate => candidate.id === jobId) : undefined;
      if (job) {
        job.status = 'ready';
        job.message = 'Ready';
        job.error = null;
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.mutate(state => {
      const target = state.library.songs.find(candidate => candidate.id === songId);
      if (target) {
        target.status = 'error';
        target.error = message;
      }
      const job = jobId ? state.library.jobs.find(candidate => candidate.id === jobId) : undefined;
      if (job) {
        job.status = 'error';
        job.error = message;
        job.message = null;
      }
    });
    throw error;
  }
}

interface ImportRequest {
  sourceRepositoryId: string;
  sourceRef: string;
  autoSeparate: boolean;
  cleanupSource?: boolean;
}

async function runImport(jobId: string, request: ImportRequest): Promise<void> {
  const repository = repositoryMap.get(request.sourceRepositoryId);
  if (!repository) throw new Error(`Unknown source repository: ${request.sourceRepositoryId}`);

  const songId = crypto.randomUUID();
  const targetDir = path.join(DATA_DIR, 'library', songId);
  await fs.promises.mkdir(targetDir, { recursive: true });

  try {
    setJob(jobId, { status: 'importing', message: 'Importing audio' });

    const materialized = await repository.materialize(request.sourceRef, {
      targetDir,
      log: message => setJob(jobId, { message })
    });

    const metadata = await parseFile(materialized.filePath, { duration: true });
    const title = metadata.common.title || path.basename(materialized.filePath, path.extname(materialized.filePath));
    const song: LibrarySong = {
      id: songId,
      title,
      artist: metadata.common.artist ?? null,
      album: metadata.common.album ?? null,
      durationSeconds: metadata.format.duration ?? 0,
      sourceRepositoryId: request.sourceRepositoryId,
      sourceRef: request.sourceRef,
      sourcePath: materialized.filePath,
      stems: [],
      status: 'imported',
      error: null,
      importedAt: new Date().toISOString()
    };

    store.mutate(state => {
      state.library.songs.unshift(song);
      const job = state.library.jobs.find(candidate => candidate.id === jobId);
      if (job) {
        job.songId = songId;
        job.message = request.autoSeparate ? 'Imported; starting separation' : 'Imported';
        job.status = request.autoSeparate ? 'separating' : 'ready';
      }
    });

    store.openSong(songId);

    if (request.autoSeparate) {
      await runSeparation(songId, jobId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setJob(jobId, { status: 'error', error: message, message: null });
    try {
      const files = await fs.promises.readdir(targetDir);
      if (files.length === 0) await fs.promises.rm(targetDir, { recursive: true, force: true });
    } catch {
      // Keep any successfully imported source material for inspection/recovery.
    }
  } finally {
    if (request.cleanupSource) {
      await fs.promises.rm(request.sourceRef, { force: true }).catch(() => undefined);
    }
  }
}

api.get('/api/health', (_req, res) => {
  res.json({ ok: true, apiVersion: 2, dataDir: DATA_DIR });
});

api.get('/api/state', (_req, res) => {
  res.json(store.snapshot());
});

api.get('/api/sources', (_req, res) => {
  res.json(repositories.map(repository => repository.descriptor));
});

api.get('/api/library', (_req, res) => {
  res.json(store.snapshot().library);
});

api.post('/api/import', (req, res) => {
  const sourceRepositoryId = String(req.body?.sourceRepositoryId ?? '');
  const sourceRef = String(req.body?.sourceRef ?? '').trim();
  const autoSeparate = req.body?.autoSeparate !== false;

  if (!repositoryMap.has(sourceRepositoryId)) return res.status(400).json({ error: 'Unknown sourceRepositoryId' });
  if (!sourceRef) return res.status(400).json({ error: 'sourceRef is required' });
  if (sourceRepositoryId === 'file') {
    return res.status(400).json({ error: 'Browser clients must use /api/import/upload for local files. Agents may pass a local path through /api/import/path.' });
  }

  const job = addJob(sourceRepositoryId, sourceRef);
  res.status(202).json(job);
  void runImport(job.id, { sourceRepositoryId, sourceRef, autoSeparate });
});

api.post('/api/import/path', (req, res) => {
  const sourceRef = String(req.body?.path ?? '').trim();
  const autoSeparate = req.body?.autoSeparate !== false;
  if (!sourceRef) return res.status(400).json({ error: 'path is required' });

  const job = addJob('file', sourceRef);
  res.status(202).json(job);
  void runImport(job.id, { sourceRepositoryId: 'file', sourceRef, autoSeparate });
});

api.post('/api/import/upload', async (req, res) => {
  try {
    const encodedName = String(req.header('x-filename') ?? '');
    const fileName = decodeURIComponent(encodedName);
    const extension = path.extname(fileName).toLowerCase();
    if (!['.wav', '.flac', '.mp3', '.m4a', '.ogg', '.opus', '.aiff', '.aif'].includes(extension)) {
      return res.status(400).json({ error: 'Unsupported audio file extension' });
    }

    const incomingDir = path.join(DATA_DIR, 'incoming');
    await fs.promises.mkdir(incomingDir, { recursive: true });
    const incomingPath = path.join(incomingDir, `${crypto.randomUUID()}${extension}`);
    await pipeline(req, fs.createWriteStream(incomingPath));

    const autoSeparate = req.query.autoSeparate !== 'false';
    const job = addJob('file', fileName || path.basename(incomingPath));
    res.status(202).json(job);

    void runImport(job.id, {
      sourceRepositoryId: 'file',
      sourceRef: incomingPath,
      autoSeparate,
      cleanupSource: true
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

api.post('/api/library/:songId/open', (req, res) => {
  try {
    res.json(store.openSong(req.params.songId));
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

api.post('/api/library/:songId/separate', (req, res) => {
  const song = store.snapshot().library.songs.find(candidate => candidate.id === req.params.songId);
  if (!song) return res.status(404).json({ error: 'Song not found' });
  if (song.status === 'separating') return res.status(409).json({ error: 'Song is already being separated' });

  res.status(202).json({ accepted: true, songId: song.id });
  void runSeparation(song.id).catch(() => undefined);
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
    if (req.body.volume !== undefined) {
      const volume = Number(req.body.volume);
      if (Number.isFinite(volume)) stem.volume = Math.max(0, Math.min(1, volume));
    }
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

if (fs.existsSync(WEB_DIR)) {
  api.use(express.static(WEB_DIR));
  api.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/media/')) {
      return res.sendFile(path.join(WEB_DIR, 'index.html'));
    }
    next();
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Trackback API: http://127.0.0.1:${PORT}`);
  if (fs.existsSync(WEB_DIR)) {
    console.log(`Trackback UI:  http://127.0.0.1:${PORT}`);
  } else {
    console.log('Development UI: http://127.0.0.1:5173');
  }
});

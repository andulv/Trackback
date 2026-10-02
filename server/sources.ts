import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface SourceDescriptor {
  id: string;
  label: string;
  description: string;
  inputKind: 'file' | 'text';
  placeholder?: string;
}

export interface MaterializeContext {
  targetDir: string;
  log(message: string): void;
}

export interface MaterializedAudio {
  filePath: string;
}

export interface SongSourceRepository {
  descriptor: SourceDescriptor;
  materialize(ref: string, context: MaterializeContext): Promise<MaterializedAudio>;
}

const audioExtensions = new Set(['.wav', '.flac', '.mp3', '.m4a', '.ogg', '.opus', '.aiff', '.aif']);

function usableExtension(value: string): string {
  const ext = path.extname(value).toLowerCase();
  return audioExtensions.has(ext) ? ext : '';
}

class LocalFileRepository implements SongSourceRepository {
  descriptor: SourceDescriptor = {
    id: 'file',
    label: 'Local file',
    description: 'Upload a local audio file into the Trackback library.',
    inputKind: 'file'
  };

  async materialize(ref: string, context: MaterializeContext): Promise<MaterializedAudio> {
    const source = path.resolve(ref);
    const stat = await fs.promises.stat(source);
    if (!stat.isFile()) throw new Error('Local source is not a file');

    const extension = usableExtension(source) || '.audio';
    const destination = path.join(context.targetDir, `source${extension}`);
    context.log('Copying local audio into the library');
    await fs.promises.copyFile(source, destination);
    return { filePath: destination };
  }
}

class HttpFileRepository implements SongSourceRepository {
  descriptor: SourceDescriptor = {
    id: 'http',
    label: 'Direct audio URL',
    description: 'Import an audio file from an HTTP(S) URL.',
    inputKind: 'text',
    placeholder: 'https://example.org/song.flac'
  };

  async materialize(ref: string, context: MaterializeContext): Promise<MaterializedAudio> {
    const url = new URL(ref);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only HTTP(S) URLs are supported');
    }

    context.log('Downloading audio');
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }

    const byUrl = usableExtension(url.pathname);
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const byType: Record<string, string> = {
      'audio/flac': '.flac',
      'audio/wav': '.wav',
      'audio/x-wav': '.wav',
      'audio/mpeg': '.mp3',
      'audio/mp4': '.m4a',
      'audio/ogg': '.ogg',
      'audio/opus': '.opus',
      'audio/aiff': '.aiff'
    };
    const extension = byUrl || byType[contentType];
    if (!extension) {
      throw new Error(`URL does not identify a supported audio file (content-type: ${contentType || 'unknown'})`);
    }

    const destination = path.join(context.targetDir, `source${extension}`);
    await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(destination));
    return { filePath: destination };
  }
}

class SpotDlRepository implements SongSourceRepository {
  descriptor: SourceDescriptor = {
    id: 'spotdl',
    label: 'Spotify / song search',
    description: 'Resolve a Spotify track URL or artist/title query with spotDL and cache the audio locally.',
    inputKind: 'text',
    placeholder: 'Ramones - KKK Took My Baby Away, or a Spotify track URL'
  };

  async materialize(ref: string, context: MaterializeContext): Promise<MaterializedAudio> {
    context.log('Resolving song with spotDL');
    const executable = process.env.TRACKBACK_SPOTDL ?? 'spotdl';
    const outputTemplate = 'source.{output-ext}';
    const expectedOutput = path.join(context.targetDir, 'source.flac');
    const args = [
      'download',
      ref,
      '--format', 'flac',
      '--output', outputTemplate,
      '--overwrite', 'force',
      '--simple-tui'
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: context.targetDir,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const consume = (chunk: Buffer) => {
        for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) context.log(line);
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.on('error', error => reject(new Error(
        `Could not start spotDL: ${error.message}. Install spotdl or set TRACKBACK_SPOTDL.`
      )));
      child.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`spotDL exited with code ${code ?? 'unknown'}`));
      });
    });

    if (fs.existsSync(expectedOutput)) {
      return { filePath: expectedOutput };
    }

    const files = (await fs.promises.readdir(context.targetDir))
      .filter(name => audioExtensions.has(path.extname(name).toLowerCase()));

    if (files.length === 0) {
      const directoryContents = await fs.promises.readdir(context.targetDir);
      throw new Error(
        `spotDL reported success but produced no supported audio file in ${context.targetDir}. Files: ${directoryContents.join(', ') || '(none)'}`
      );
    }
    if (files.length > 1) {
      throw new Error('The query resolved to multiple songs. Import one track at a time in this version.');
    }

    return { filePath: path.join(context.targetDir, files[0]) };
  }
}

export function createSourceRepositories(): SongSourceRepository[] {
  return [
    new LocalFileRepository(),
    new HttpFileRepository(),
    new SpotDlRepository()
  ];
}

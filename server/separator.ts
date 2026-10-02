import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { StemId, StemState } from './state';

export async function separateSixStems(
  inputPath: string,
  outputDir: string,
  modelDir: string,
  onLog: (line: string) => void
): Promise<StemState[]> {
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.mkdir(modelDir, { recursive: true });

  const outputNames = JSON.stringify({
    Vocals: 'vocals',
    Drums: 'drums',
    Bass: 'bass',
    Guitar: 'guitar',
    Piano: 'piano',
    Other: 'other'
  });

  const executable = process.env.TRACKBACK_AUDIO_SEPARATOR ?? 'audio-separator';
  const model = process.env.TRACKBACK_SEPARATOR_MODEL ?? 'htdemucs_6s.yaml';
  const args = [
    inputPath,
    '--model_filename', model,
    '--model_file_dir', modelDir,
    '--output_format', 'FLAC',
    '--output_dir', outputDir,
    '--custom_output_names', outputNames
  ];

  const env = { ...process.env };
  if ((process.env.TRACKBACK_SEPARATOR_DEVICE ?? 'auto').toLowerCase() === 'cpu') {
    env.CUDA_VISIBLE_DEVICES = '';
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });

    const consume = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) onLog(line);
    };

    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', error => reject(new Error(
      `Could not start audio-separator: ${error.message}. Install audio-separator or set TRACKBACK_AUDIO_SEPARATOR.`
    )));
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`audio-separator exited with code ${code ?? 'unknown'}`));
    });
  });

  const ids: Exclude<StemId, 'original'>[] = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
  const files = await fs.promises.readdir(outputDir);

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

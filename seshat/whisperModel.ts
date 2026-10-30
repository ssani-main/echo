// Port of ../whisperModel.js: the model registry and the first-use download into a per-user cache. Models are
// data (safe to fetch); the whisper-cli binary is never downloaded (see whisper.ts). Local/desktop only; the
// routes are gated. Checked by check/whispermodel.cases.ts and, the download itself, whispermodel-live.cases.ts.

import { statSync } from 'node:fs';
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
// shortcut: std/crypto, as node:crypto goes through Seshat's npm bridge (gap: node-crypto-bridged); under
// node, check/node-bun.mjs maps it to node:crypto.
import { createHash } from 'std/crypto';
import { EchoError } from './errors.ts';

export interface WhisperModel {
  name: string;
  label: string;
  file: string;
  url: string;
  sizeBytes: number;
  sha256: string;
}

// ggml q5_1 models from the whisper.cpp HF repo. base = default (fast, ~3x quicker than small on CPU);
// small = accuracy tier. Sizes + sha256 verified 2026-07-19.
export const WHISPER_MODELS: Record<string, WhisperModel> = {
  base: {
    name: 'base',
    label: 'Base (fast)',
    file: 'ggml-base-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
    sizeBytes: 59707625,
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
  },
  small: {
    name: 'small',
    label: 'Small (accurate)',
    file: 'ggml-small-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
    sizeBytes: 190085487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  },
};

export const DEFAULT_WHISPER_MODEL = 'base';

// Per-user cache dir: must survive reboots and app updates (not tmpdir). Overridable.
export function modelCacheDir(): string {
  const override = process.env.ECHO_WHISPER_MODEL_DIR;
  if (override) return override;
  const home = homedir();
  let base: string;
  if (process.platform === 'win32') {
    base = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  } else if (process.platform === 'darwin') {
    base = join(home, 'Library', 'Application Support');
  } else {
    base = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
  }
  return join(base, 'echo', 'whisper-models');
}

export function modelInfo(name: string): WhisperModel | null {
  return WHISPER_MODELS[name] || null;
}

// On-disk path for a model (whether or not it exists yet).
export function modelFilePath(name: string): string | null {
  const m = WHISPER_MODELS[name];
  return m ? join(modelCacheDir(), m.file) : null;
}

// Fully present? Exists AND has the exact expected size (guards truncated or partial files).
export function isModelPresent(name: string): boolean {
  const m = WHISPER_MODELS[name];
  if (!m) return false;
  try {
    return statSync(join(modelCacheDir(), m.file)).size === m.sizeBytes;
  } catch {
    return false;
  }
}

interface DownloadJob { state: string; received: number; total: number; error: string | null }

export interface DownloadState {
  name: string;
  present: boolean;
  state: string;
  received: number;
  total: number;
  percent: number;
  error?: string | null;
}

// In-memory download progress, keyed by model name (process lifetime).
const downloads = new Map<string, DownloadJob>();

export function downloadState(name: string): DownloadState {
  const m = WHISPER_MODELS[name];
  if (!m) return { name, present: false, state: 'unknown', received: 0, total: 0, percent: 0 };
  if (isModelPresent(name)) {
    return { name, present: true, state: 'present', received: m.sizeBytes, total: m.sizeBytes, percent: 100 };
  }
  const job = downloads.get(name);
  if (job) {
    const percent = job.total ? Math.floor((job.received / job.total) * 100) : 0;
    return { name, present: false, state: job.state, received: job.received, total: job.total, percent, error: job.error };
  }
  return { name, present: false, state: 'absent', received: 0, total: m.sizeBytes, percent: 0 };
}

// Idempotent: starts a download unless the model is present or already downloading.
export function startModelDownload(name: string, opts: { signal?: AbortSignal } = {}): { state: string } {
  const m = WHISPER_MODELS[name];
  if (!m) throw new EchoError(`Unknown model: ${name}`, 'WHISPER_MODEL_UNKNOWN');
  if (isModelPresent(name)) return { state: 'present' };
  const existing = downloads.get(name);
  if (existing && existing.state === 'downloading') return { state: 'downloading' };
  downloads.set(name, { state: 'downloading', received: 0, total: m.sizeBytes, error: null });
  doDownload(m, opts)
    .then(() => { downloads.set(name, { state: 'done', received: m.sizeBytes, total: m.sizeBytes, error: null }); })
    .catch((err: Error) => { downloads.set(name, { state: 'error', received: 0, total: m.sizeBytes, error: err.message || String(err) }); });
  return { state: 'downloading' };
}

async function doDownload(m: WhisperModel, opts: { signal?: AbortSignal }): Promise<void> {
  const dir = modelCacheDir();
  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, m.file);
  const tmpPath = join(dir, `${m.file}.part-${process.pid}`);

  const res = opts.signal ? await fetch(m.url, { redirect: 'follow', signal: opts.signal }) : await fetch(m.url, { redirect: 'follow' });
  const body = res.body;
  if (!res.ok || !body) {
    throw new EchoError(`Model download failed: HTTP ${res.status}`, 'WHISPER_MODEL_DOWNLOAD_FAILED');
  }
  const total = Number(res.headers.get('content-length')) || m.sizeBytes;
  const hash = createHash('sha256');
  let received = 0;

  // `pipeline(Readable.fromWeb(res.body), meter, createWriteStream(tmpPath))`: each chunk counted, hashed and
  // written. writeFile first, as createWriteStream truncates a part file left by an earlier run.
  try {
    await writeFile(tmpPath, new Uint8Array(0));
    for await (const chunk of body) {
      received += chunk.length;
      hash.update(chunk);
      const job = downloads.get(m.name);
      if (job && job.state === 'downloading') { job.received = received; job.total = total; }
      await appendFile(tmpPath, chunk);
    }
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw new EchoError(`Model download interrupted: ${err instanceof Error ? err.message : String(err)}`, 'WHISPER_MODEL_DOWNLOAD_FAILED');
  }

  const digest = hash.digest('hex');
  let size = 0;
  try { size = (await stat(tmpPath)).size; } catch { /* ignore */ }
  if (size !== m.sizeBytes || digest !== m.sha256) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw new EchoError(`Model verification failed (size ${size}/${m.sizeBytes}, sha256 ${digest === m.sha256 ? 'ok' : 'mismatch'}).`, 'WHISPER_MODEL_VERIFY_FAILED');
  }
  await rename(tmpPath, finalPath); // atomic within the same dir
}

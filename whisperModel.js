// whisperModel.js — model registry + first-use download/cache for local Whisper (P2).
// Models are DATA (safe to fetch); the whisper-cli BINARY is never auto-downloaded
// (env/vendored only — see whisper.js). Local/desktop only; the server gates the routes.
import { createWriteStream, existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// ggml q5_1 models from the whisper.cpp HF repo. base = default (fast, ~3x quicker than
// small on CPU); small = accuracy tier. Sizes + sha256 verified 2026-07-19.
export const WHISPER_MODELS = {
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

// Per-user cache dir — must survive reboots/app updates (NOT tmpdir). Overridable.
export function modelCacheDir() {
  if (process.env.ECHO_WHISPER_MODEL_DIR) return process.env.ECHO_WHISPER_MODEL_DIR;
  const home = os.homedir();
  let base;
  if (process.platform === 'win32') {
    base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  } else if (process.platform === 'darwin') {
    base = path.join(home, 'Library', 'Application Support');
  } else {
    base = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  }
  return path.join(base, 'echo', 'whisper-models');
}

export function modelInfo(name) {
  return WHISPER_MODELS[name] || null;
}

// On-disk path for a model (whether or not it exists yet).
export function modelFilePath(name) {
  const m = WHISPER_MODELS[name];
  return m ? path.join(modelCacheDir(), m.file) : null;
}

// Fully present? exists AND exact expected size (guards truncated/partial files).
export function isModelPresent(name) {
  const m = WHISPER_MODELS[name];
  if (!m) return false;
  try {
    return statSync(path.join(modelCacheDir(), m.file)).size === m.sizeBytes;
  } catch {
    return false;
  }
}

// In-memory download progress, keyed by model name (process-lifetime).
const downloads = new Map(); // name -> { state, received, total, error }

export function downloadState(name) {
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

// Idempotent: start a download if not present and not already running.
export function startModelDownload(name, opts = {}) {
  const m = WHISPER_MODELS[name];
  if (!m) {
    const e = new Error(`Unknown model: ${name}`);
    e.echoCode = 'WHISPER_MODEL_UNKNOWN';
    throw e;
  }
  if (isModelPresent(name)) return { state: 'present' };
  const existing = downloads.get(name);
  if (existing && existing.state === 'downloading') return { state: 'downloading' };
  downloads.set(name, { state: 'downloading', received: 0, total: m.sizeBytes, error: null });
  doDownload(name, opts)
    .then(() => downloads.set(name, { state: 'done', received: m.sizeBytes, total: m.sizeBytes, error: null }))
    .catch((err) => downloads.set(name, { state: 'error', received: 0, total: m.sizeBytes, error: err.message || String(err) }));
  return { state: 'downloading' };
}

async function doDownload(name, opts) {
  const m = WHISPER_MODELS[name];
  const dir = modelCacheDir();
  await fs.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, m.file);
  const tmpPath = path.join(dir, `${m.file}.part-${process.pid}`);

  const res = await fetch(m.url, { redirect: 'follow', signal: opts.signal });
  if (!res.ok || !res.body) {
    const e = new Error(`Model download failed: HTTP ${res.status}`);
    e.echoCode = 'WHISPER_MODEL_DOWNLOAD_FAILED';
    throw e;
  }
  const total = Number(res.headers.get('content-length')) || m.sizeBytes;
  const hash = crypto.createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      hash.update(chunk);
      const job = downloads.get(name);
      if (job && job.state === 'downloading') { job.received = received; job.total = total; }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(tmpPath));
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    const e = new Error(`Model download interrupted: ${err.message}`);
    e.echoCode = 'WHISPER_MODEL_DOWNLOAD_FAILED';
    throw e;
  }

  const digest = hash.digest('hex');
  let size = 0;
  try { size = (await fs.stat(tmpPath)).size; } catch { /* ignore */ }
  if (size !== m.sizeBytes || digest !== m.sha256) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    const e = new Error(`Model verification failed (size ${size}/${m.sizeBytes}, sha256 ${digest === m.sha256 ? 'ok' : 'mismatch'}).`);
    e.echoCode = 'WHISPER_MODEL_VERIFY_FAILED';
    throw e;
  }
  await fs.rename(tmpPath, finalPath); // atomic within the same dir
}

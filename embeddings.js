// embeddings.js — Optional local semantic layer using @xenova/transformers
// Degrades gracefully: if the package is missing or the model fails to load,
// isAvailable() stays false and all callers transparently fall back to keyword-only.

import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const MODEL_NAME  = 'Xenova/all-MiniLM-L6-v2';
// Model cache dir is normally relative to this file, but that's read-only
// once bundled inside a packaged desktop app. ECHO_MODELS_DIR lets the
// Tauri launcher point this at a writable app-data directory; unset by
// default so plain `npm start` behavior is unchanged.
const MODEL_CACHE = process.env.ECHO_MODELS_DIR || join(__dirname, 'data', 'models');

let _pipeline      = null;
let _available     = false;
let _failureReason = null;
let _initDone      = false;
let _initPromise   = null;

/**
 * Lazy-initialize the embedding pipeline.
 * Safe to call multiple times — returns the same Promise after the first call.
 * Never throws; sets _available = false and logs on failure.
 * @returns {Promise<void>}
 */
export async function initEmbeddings() {
  if (_initDone)    return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      // Dynamic import so a missing package doesn't crash module load
      const { pipeline, env } = await import('@xenova/transformers');
      env.cacheDir = MODEL_CACHE;
      // quantized = smaller download + faster inference
      _pipeline  = await pipeline('feature-extraction', MODEL_NAME, { quantized: true });
      _available = true;
      console.log('[embeddings] Model loaded:', MODEL_NAME);
    } catch (err) {
      _available     = false;
      _failureReason = String(err?.message ?? err);
      console.warn('[embeddings] Semantic search disabled —', _failureReason);
    } finally {
      _initDone = true;
    }
  })();

  return _initPromise;
}

/** Returns true if the embedding model is loaded and ready. */
export function isAvailable() { return _available; }

/** Returns the error string that prevented model load, or null. */
export function getFailureReason() { return _failureReason; }

/**
 * Embed a text string using the loaded model.
 * Returns a number[] (mean-pooled, L2-normalized), or null on any failure.
 * Safe to call before init completes — will just return null.
 * @param {string} text
 * @returns {Promise<number[] | null>}
 */
export async function embedText(text) {
  if (!_available || !_pipeline) return null;
  try {
    const output = await _pipeline(String(text), { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  } catch (err) {
    console.error('[embeddings] embedText error:', String(err?.message ?? err));
    return null;
  }
}

/**
 * Cosine similarity between two float vectors.
 * Returns a value in [-1, 1]; higher = more similar.
 * Returns 0 if vectors are mismatched or degenerate.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom < 1e-12 ? 0 : dot / denom;
}

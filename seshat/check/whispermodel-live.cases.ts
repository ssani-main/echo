// whisperModel.js's download against the port's, for real: the base model (60 MB) from Hugging Face into an
// empty folder (ECHO_WHISPER_MODEL_DIR, set by run.mjs), size and sha256 checked by the module itself. Needs the
// network, and downloads it once per run (three times in all).
import { readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadState, startModelDownload, isModelPresent } from '../whisperModel.ts';
import { out } from './out.ts';

const dir = process.env.ECHO_WHISPER_MODEL_DIR ?? join(tmpdir(), 'unset');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

out('start', startModelDownload('base'));
out('start again', startModelDownload('base'));
let last = -1;
let monotonic = true;
let sawProgress = false;
let state = downloadState('base');
const deadline = Date.now() + 10 * 60_000;
while (state.state === 'downloading' && Date.now() < deadline) {
  if (state.percent < last || state.percent > 100) monotonic = false;
  if (state.percent > 0 && state.percent < 100) sawProgress = true;
  last = state.percent;
  await new Promise((r) => setTimeout(r, 100));
  state = downloadState('base');
}
out('progress', { monotonic, sawProgress });
out('final', state);
out('present', isModelPresent('base'));
out('files', readdirSync(dir));
out('start when present', startModelDownload('base'));
rmSync(dir, { recursive: true, force: true });

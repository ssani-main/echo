// whisperModel.js against the port: the registry, the cache paths and the download states, on a model folder
// of its own (ECHO_WHISPER_MODEL_DIR, set by run.mjs: Seshat can't assign process.env). Present means the exact size, so a zero-filled file stands in for the
// model; the download itself is whispermodel-live.cases.ts.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WHISPER_MODELS, DEFAULT_WHISPER_MODEL, modelCacheDir, modelInfo, modelFilePath, isModelPresent, downloadState,
  startModelDownload,
} from '../whisperModel.ts';
import { out } from './out.ts';

const dir = process.env.ECHO_WHISPER_MODEL_DIR ?? join(tmpdir(), 'unset');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const masked = (p: string | null): string | null => (p === null ? null : p.replace(dir, '<dir>'));

out('WHISPER_MODELS', WHISPER_MODELS);
out('DEFAULT_WHISPER_MODEL', DEFAULT_WHISPER_MODEL);
out('modelCacheDir/override', masked(modelCacheDir()));
for (const name of ['base', 'small', 'tiny', '', 'BASE']) {
  out(`modelInfo/${name}`, modelInfo(name));
  out(`modelFilePath/${name}`, masked(modelFilePath(name)));
  out(`isModelPresent/${name}`, isModelPresent(name));
  out(`downloadState/${name}`, downloadState(name));
}

function startCase(name: string): void {
  try {
    out(`startModelDownload/${name}`, startModelDownload(name));
  } catch (e) {
    const err = e as Error & { echoCode?: string };
    out(`startModelDownload/${name} threw`, [err.message, err.echoCode]);
  }
}
startCase('tiny');
startCase('');

// A part-sized file isn't the model; the exact size is.
writeFileSync(join(dir, 'ggml-base-q5_1.bin'), new Uint8Array(1000));
out('isModelPresent/base short', isModelPresent('base'));
out('downloadState/base short', downloadState('base'));
writeFileSync(join(dir, 'ggml-base-q5_1.bin'), new Uint8Array(59707625));
out('isModelPresent/base sized', isModelPresent('base'));
out('downloadState/base sized', downloadState('base'));
startCase('base');
out('downloadState/small still absent', downloadState('small'));
rmSync(dir, { recursive: true, force: true });
out('isModelPresent/base gone', isModelPresent('base'));

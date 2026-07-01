import { spawn } from 'node:child_process';

const CCUSAGE_TIMEOUT_MS = 60_000; // 1 minute

// Module-level in-memory cache: { ts: number, data: object } | null
let cache = null;

/**
 * Returns today's Claude Code usage totals via ccusage (run on demand via npx).
 * Never throws — always resolves with an object.
 *
 * @returns {Promise<{ available: boolean, date?: string, costUsd?: number, totalTokens?: number, error?: string }>}
 */
export async function getTodayUsage() {
  const now = Date.now();

  // Return cached result if fresh (< 60 s old)
  if (cache && (now - cache.ts) < 60_000) {
    return cache.data;
  }

  return new Promise((resolve) => {
    let settled = false;

    const child = spawn('npx', ['-y', 'ccusage@latest', 'daily', '--json'], {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    // --- timeout ---
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) { /* ignore */ }
      resolve({ available: false, error: 'ccusage timed out' });
    }, CCUSAGE_TIMEOUT_MS);

    // --- spawn error ---
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ available: false, error: err.message });
    });

    // --- collect output ---
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    // --- handle exit ---
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        const detail = Buffer.concat(stderrChunks).toString('utf8').trim().slice(0, 300)
          || '(no stderr)';
        return resolve({ available: false, error: `ccusage exited with code ${code}: ${detail}` });
      }

      const raw = Buffer.concat(stdoutChunks).toString('utf8').trim();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        return resolve({ available: false, error: `ccusage returned non-JSON: ${raw.slice(0, 200)}` });
      }

      // Build today's date string in local time: "YYYY-MM-DD"
      const d = new Date();
      const today = [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      ].join('-');

      const daily = Array.isArray(parsed.daily) ? parsed.daily : [];
      const entry = daily.find(
        (e) => e && (e.period === today || String(e.period).startsWith(today))
      );

      const result = {
        available: true,
        date: today,
        costUsd: entry ? entry.totalCost : 0,
        totalTokens: entry ? entry.totalTokens : 0,
      };

      // Cache the successful result
      cache = { ts: Date.now(), data: result };

      return resolve(result);
    });
  });
}

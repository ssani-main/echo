import { spawn } from 'node:child_process';

const CCUSAGE_TIMEOUT_MS = 60_000; // 1 minute

// Module-level in-memory cache: { ts: number, data: object } | null
let cache = null;

// Module-level in-flight guard: while a ccusage spawn is running, concurrent
// callers await this same promise instead of starting their own subprocess.
let pending = null;

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

  // A spawn is already in flight for a cache miss — piggyback on it instead
  // of starting a second concurrent ccusage subprocess.
  if (pending) {
    return pending;
  }

  pending = new Promise((resolve) => {
    let settled = false;

    let child;
    try {
      if (process.platform === 'win32') {
        // On Windows, spawn('npx.cmd', args, { shell: false }) throws EINVAL
        // synchronously (post CVE-2024-27980 Node behavior), which would
        // escape this promise executor as an unhandled rejection. Run via a
        // shell instead, passing the full command as a single string (not a
        // separate args array) to avoid the DEP0190 deprecation warning.
        // All tokens here are hardcoded constants — no user input — so
        // there is no shell-injection surface.
        child = spawn('npx -y ccusage@latest daily --json', {
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } else {
        child = spawn('npx', ['-y', 'ccusage@latest', 'daily', '--json'], {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
    } catch (err) {
      settled = true;
      resolve({ available: false, error: err.message });
      return;
    }

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

  // Clear the in-flight guard once settled (success or failure) so the next
  // cache miss can spawn a fresh ccusage call.
  pending.finally(() => { pending = null; });

  return pending;
}

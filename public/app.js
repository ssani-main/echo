// Echo — the whole client.
//
// Extracted from the inline <script> in index.html, unchanged: this is a
// classic script, NOT a module, so every top-level binding stays on the same
// shared scope it has always had. Splitting it further means splitting that
// scope, which is a different and much riskier change.
//
// Served from memory and pre-gzipped at boot (see server.js) — editing it
// needs a server restart in dev, exactly like index.html.

/* ==============================================
   WEB MODE FLAG — injected by the server as
   window.__ECHO__ = { mode }. Falls back to local-mode
   defaults when unset (e.g. tests).
=============================================== */
const ECHO = window.__ECHO__ || { mode: 'local' };

/* ==============================================
   LIBRARY STORAGE ADAPTER
   ServerLibrary makes the exact same /api/saved and
   /api/search HTTP calls that were previously inlined
   at each call site. This is a pure extract-and-route
   refactor — behavior is byte-for-byte identical to
   before. (A client-side IndexedDbLibrary backend for
   web mode is added in a later step.)
=============================================== */
const ServerLibrary = {
  /** GET /api/saved -> meta[] (whole library), or one page when limit is given */
  listEntries({ limit, offset } = {}) {
    if (!limit) return fetch('/api/saved');
    return fetch(`/api/saved?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset || 0)}`);
  },

  /** GET /api/saved/:id -> entry|null (raw Response, caller inspects .status/.ok) */
  getEntry(videoId) {
    return fetch(`/api/saved/${encodeURIComponent(videoId)}`);
  },

  /** POST /api/saved -> saved meta/entry (raw Response) */
  saveEntry(payload) {
    return fetch('/api/saved', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  },

  /** DELETE /api/saved/:id (raw Response) */
  deleteEntry(videoId) {
    return fetch(`/api/saved/${encodeURIComponent(videoId)}`, {
      method: 'DELETE',
    });
  },

  /** PATCH /api/saved/:id/tags -> entry (raw Response) */
  setTags(videoId, tags) {
    return fetch(`/api/saved/${encodeURIComponent(videoId)}/tags`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tags }),
    });
  },

  /** GET /api/saved/export -> {entries:[...]} (raw Response) */
  exportAll() {
    return fetch('/api/saved/export');
  },

  /** GET /api/saved/:id/export.md -> markdown text (raw Response) */
  entryMarkdown(videoId) {
    return fetch(`/api/saved/${encodeURIComponent(videoId)}/export.md`);
  },

  /** GET /api/search?q=&limit=50 -> {results, mode} (raw Response) */
  searchLibrary(q) {
    return fetch(`/api/search?q=${encodeURIComponent(q)}&limit=50`);
  },
};

/* ==============================================
   ENTRY -> MARKDOWN (CLIENT-SIDE)
   Shared by exportSavedLibrary()'s zip builder and
   IndexedDbLibrary.entryMarkdown() (web mode has no
   server-side store of record, so Markdown must be
   assembled in the browser). Deliberately mirrors the
   server's markdown.js entryToMarkdown() at a lighter
   weight — this
   matches the template that was previously inlined in
   exportSavedLibrary() before this extraction.
=============================================== */
// YAML-escape a scalar for use inside a double-quoted frontmatter value.
const escapeYamlClient = (s) => String(s || '').replace(/"/g, '\\"');

/**
 * Client-side mirror of markdown.js's extractSummary() — prefers a
 * "## TL;DR" section, falls back to the first non-heading paragraph.
 * Kept byte-for-byte in sync with the server algorithm.
 */
function extractSummaryClient(digest, maxLen = 240) {
  const text = String(digest || '').trim();
  if (!text) return '';

  const lines = text.split('\n');
  const tldrRe = /^#{1,6}\s*tl;?dr/i;
  const headingRe = /^#{1,6}\s/;

  let collected = [];
  const tldrIdx = lines.findIndex((l) => tldrRe.test(l.trim()));
  if (tldrIdx !== -1) {
    // Skip the blank line(s) between the heading and its paragraph before
    // collecting. Breaking on the first blank meant a digest written as
    // "## TL;DR\n\nThe point." — ordinary Markdown, and what the model
    // actually emits — produced an empty summary. Kept in step with
    // markdown.js extractSummary(), which had the same bug.
    let i = tldrIdx + 1;
    while (i < lines.length && !lines[i].trim()) i++;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) break;
      if (headingRe.test(line.trim())) break;
      collected.push(line);
    }
  } else {
    let started = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!started) {
        if (!trimmed) continue;
        if (headingRe.test(trimmed)) continue;
        started = true;
        collected.push(line);
      } else {
        if (!trimmed) break;
        if (headingRe.test(trimmed)) break;
        collected.push(line);
      }
    }
  }

  let summary = collected
    .join(' ')
    .replace(/[*_`>#]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (summary.length > maxLen) {
    summary = summary.slice(0, maxLen - 1).trimEnd() + '…';
  }

  return summary;
}

const MONTHS_CLIENT = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function wikilinkAliasClient(title) {
  return String(title || '').replace(/[[\]]/g, '').replace(/\|/g, '-');
}

/**
 * Client-side mirror of markdown.js's buildVaultIndex() — renders the
 * "Echo Library.md" dashboard note. Kept byte-for-byte in sync with the
 * server algorithm.
 */
function buildVaultIndexClient(items) {
  const list = Array.isArray(items) ? items : [];
  const lines = [];
  lines.push('---', 'title: Echo Library', 'tags: [echo/index]', '---', '');
  lines.push('# Echo Library', '');
  lines.push('`' + list.length + ' saved video' + (list.length === 1 ? '' : 's') + '`', '');

  // By date
  const buckets = new Map();
  for (const item of list) {
    let label = 'Undated', year = -Infinity, month = -Infinity;
    const d = item.savedAt ? new Date(item.savedAt) : null;
    if (d && !isNaN(d.getTime())) { year = d.getUTCFullYear(); month = d.getUTCMonth(); label = MONTHS_CLIENT[month] + ' ' + year; }
    if (!buckets.has(label)) buckets.set(label, { year, month, items: [] });
    buckets.get(label).items.push(item);
  }
  const bucketLabels = Array.from(buckets.keys()).sort((a, b) => {
    if (a === 'Undated') return 1; if (b === 'Undated') return -1;
    const ba = buckets.get(a), bb = buckets.get(b);
    if (ba.year !== bb.year) return bb.year - ba.year;
    return bb.month - ba.month;
  });
  lines.push('## By date', '');
  for (const label of bucketLabels) {
    const sorted = [...buckets.get(label).items];
    if (label !== 'Undated') sorted.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
    lines.push('### ' + label, '');
    for (const item of sorted) {
      const alias = wikilinkAliasClient(item.title);
      lines.push('- [[' + item.link + '|' + alias + ']]' + (item.summary ? ' — ' + item.summary : ''));
    }
    lines.push('');
  }

  // By topic (clusters of >= 2 only)
  const tagMap = new Map();
  for (const item of list) {
    const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean) : [];
    for (const tag of tags) { if (!tagMap.has(tag)) tagMap.set(tag, []); tagMap.get(tag).push(item); }
  }
  const clustered = Array.from(tagMap.keys()).filter((t) => tagMap.get(t).length >= 2);
  if (clustered.length) {
    const tagNames = clustered.sort((a, b) => { const ca = tagMap.get(a).length, cb = tagMap.get(b).length; if (ca !== cb) return cb - ca; return a.localeCompare(b); });
    lines.push('## By topic', '');
    for (const tag of tagNames) {
      const members = [...tagMap.get(tag)].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
      lines.push('- **' + tag + '** (' + members.length + ')');
      for (const item of members) lines.push('  - [[' + item.link + '|' + wikilinkAliasClient(item.title) + ']]');
    }
    lines.push('');
  }

  // All notes
  lines.push('## All notes', '');
  const allSorted = [...list].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  for (const item of allSorted) lines.push('- [[' + item.link + '|' + wikilinkAliasClient(item.title) + ']]');

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

function entryToMarkdownClient(entry, opts = {}) {
  const includeTranscript = opts.includeTranscript !== false;
  const e = entry || {};
  const title = e.title || e.videoId || 'Untitled';
  const safeSrc = safeHttpUrl(e.url);
  const tags = Array.isArray(e.tags) ? e.tags.filter(Boolean) : [];

  const fm = ['---'];
  fm.push(`title: "${escapeYamlClient(title)}"`);
  if (safeSrc) fm.push(`url: "${escapeYamlClient(safeSrc)}"`);
  fm.push(`videoId: "${escapeYamlClient(e.videoId || '')}"`);
  if (tags.length) fm.push(`tags: [${tags.map((t) => `"${escapeYamlClient(t)}"`).join(', ')}]`);
  const summary = extractSummaryClient(e.digest);
  if (summary) fm.push(`summary: "${escapeYamlClient(summary)}"`);
  fm.push(`savedAt: "${escapeYamlClient(e.savedAt || '')}"`);
  fm.push('---', '');

  let md = fm.join('\n') + `# ${title}\n\n${safeSrc ? `Source: ${safeSrc}\n\n` : ''}`;

  if (e.digest) {
    md += `## AI digest\n\n${e.digest}\n\n`;
  }

  if (includeTranscript && Array.isArray(e.segments) && e.segments.length > 0) {
    const paras = reflowToParagraphs(e.segments);
    md += paras.join('\n\n');
  }

  return md;
}

/* ==============================================
   INDEXEDDB LIBRARY (web mode)
   Client-side storage backend used when ECHO.mode ===
   'web' (no server-side store of record — every browser
   tab/profile has its own local library). Exposes the
   exact same method set as ServerLibrary so all ~16
   existing call sites work unchanged; every method
   returns a real Response object (via the Response
   constructor) so callers can keep using res.ok /
   res.status / res.json() / res.text() as before.

   Schema: a single object store "videos" (keyPath
   videoId, index on savedAt) holding the FULL entry
   object { videoId, url, title, savedAt, updatedAt,
   segments, digest, favorite, tags }
   — this matches the shape store.getEntry() returns on
   the server, so listEntries()/getEntry() render
   identically in both modes. (A normalized 4-store form
   mirroring store.js's SQLite tables was considered but
   rejected: it would require multi-store transactions
   for every write with no benefit at this data scale.)
=============================================== */
// Stopword list used by IndexedDbLibrary.searchLibrary() so free-text
// search queries ("videos about living in Germany") reduce to signal
// tokens ("videos", "living", "germany") instead of matching nothing.
const IDB_FTS_STOPWORDS = new Set([
  'what', 'is', 'are', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for',
  'and', 'or', 'about', 'does', 'do', 'did', 'how', 'why', 'this', 'that',
  'with', 'from', 'your', 'my',
]);

/** Tokenize free text into lowercase signal words. */
function idbFtsTokens(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const tokens = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const filtered = tokens.filter((t) => t.length > 2 && !IDB_FTS_STOPWORDS.has(t));
  return filtered.length > 0 ? filtered : tokens;
}

const ECHO_DB_NAME    = 'echo';
// v2 added the `meta` store. See idbOpen().
const ECHO_DB_VERSION = 2;
let _echoDbPromise = null;

/**
 * Open (or reuse) the shared IndexedDB connection.
 *
 * TWO stores, for the reason store.js projects columns instead of selecting *:
 * an entry is a whole transcript, and the library list needs none of it.
 * Reading every record to build that list meant 13.1 MB read to produce 23 KB
 * of metadata at 120 entries — measured — and it grew with the library.
 *
 *   videos — the full entries, keyed by videoId
 *   meta   — one small record per entry: exactly what a list row shows, plus
 *            updatedAt so sync can tell what changed without reading transcripts
 *
 * They are written and deleted in the same transaction everywhere, so the two
 * cannot drift; IndexedDB rolls the whole transaction back on failure.
 */
function idbOpen() {
  if (_echoDbPromise) return _echoDbPromise;
  _echoDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(ECHO_DB_NAME, ECHO_DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('videos')) {
        const store = db.createObjectStore('videos', { keyPath: 'videoId' });
        store.createIndex('savedAt', 'savedAt');
      }
      if (!db.objectStoreNames.contains('meta')) {
        const meta = db.createObjectStore('meta', { keyPath: 'videoId' });
        meta.createIndex('savedAt', 'savedAt');

        // Backfill from whatever is already saved. Walked with a cursor rather
        // than getAll() so an existing large library does not have to fit in
        // memory during the upgrade — the one moment it certainly must not fail.
        const tx = event.target.transaction;
        const videos = tx.objectStore('videos');
        const metaStore = tx.objectStore('meta');
        const cursorReq = videos.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          metaStore.put(idbToMetaRecord(cursor.value));
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _echoDbPromise;
}

/**
 * The stored meta record: what a list row shows, plus updatedAt.
 *
 * updatedAt is not part of the shape the server's listEntries returns, but sync
 * needs it to decide what changed — and reading it from here is the difference
 * between a no-op sync costing kilobytes and costing the whole library.
 */
function idbToMetaRecord(entry) {
  return { ...idbToMeta(entry), updatedAt: entry.updatedAt || entry.savedAt || '' };
}

/** Wrap a single IDBRequest in a Promise. */
function idbReq(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

async function idbGetEntry(videoId) {
  const db = await idbOpen();
  return idbReq(db.transaction('videos', 'readonly').objectStore('videos').get(videoId));
}

async function idbGetAllEntries() {
  const db = await idbOpen();
  return idbReq(db.transaction('videos', 'readonly').objectStore('videos').getAll());
}

/** Every meta record — kilobytes, where idbGetAllEntries() is megabytes. */
async function idbGetAllMeta() {
  const db = await idbOpen();
  return idbReq(db.transaction('meta', 'readonly').objectStore('meta').getAll());
}

/**
 * Walk full entries one at a time, for the two paths that genuinely need the
 * transcript text (search and export). Same bytes read as getAll(), but only
 * one entry is held at a time rather than the entire library.
 *
 * @param {(entry: object) => void} onEntry
 */
async function idbForEachEntry(onEntry) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const req = tx.objectStore('videos').openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      onEntry(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Put (insert or overwrite) a full entry record; resolves once the write transaction commits. */
function idbPutEntry(entry) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    // Both stores in ONE transaction: a full entry without its meta record
    // would be invisible to the library list, and a meta record without its
    // entry would be a row that opens to nothing.
    const tx = db.transaction(['videos', 'meta'], 'readwrite');
    tx.objectStore('videos').put(entry);
    tx.objectStore('meta').put(idbToMetaRecord(entry));
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  }));
}

/** Delete an entry record by videoId; resolves once the write transaction commits. */
function idbDeleteEntryRow(videoId) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(['videos', 'meta'], 'readwrite');
    tx.objectStore('videos').delete(videoId);
    tx.objectStore('meta').delete(videoId);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  }));
}

/** Mirrors store.js's tag sanitize logic: trim, dedup, drop empties, cap at 20. */
function idbSanitizeTags(tags) {
  return Array.isArray(tags)
    ? [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20)
    : [];
}

/** Mirrors store.js's toMeta(): the metadata-only shape returned by listEntries(). */
function idbToMeta(entry) {
  return {
    videoId:        entry.videoId,
    url:            entry.url,
    title:          entry.title,
    savedAt:        entry.savedAt,
    hasDigest:      !!entry.digest,
    segmentCount:   entry.segments?.length || 0,
    tags:           Array.isArray(entry.tags)       ? entry.tags        : [],
    favorite:       typeof entry.favorite === 'boolean' ? entry.favorite : false,
  };
}

/** Build a JSON Response matching the server's { error: { code, message, hint } } envelope. */
function idbJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function idbErr(message, status, code = 'INTERNAL', hint = '') {
  return idbJson({ error: { code, message, hint } }, status);
}
/** Catch-all for unexpected IndexedDB failures — mirrors server's sendCaughtError(). */
function idbCaughtError(err) {
  console.error('[echo] IndexedDbLibrary error:', err);
  return idbErr('An unexpected error occurred.', 500);
}

/* ==============================================
   LIBRARY SYNC (web mode, signed in)
   The browser's IndexedDB stays the source of truth for reading — the app
   never waits on the network to show a library. Sync is a background
   reconciliation on top: push what changed here, pull what changed
   elsewhere, last write wins by updatedAt.

   Deliberately NOT a CRDT. The conflict this has to survive is one person
   on two devices, where the later edit is the one they meant. Collaborators
   would need more; there are none.

   The Anthropic API key is not part of any of this and never leaves this
   browser — signing in changes where your LIBRARY lives, not your key.
=============================================== */
const EchoSync = (() => {
  const CURSOR_KEY = 'echo-sync-cursor';
  // Bound on how many pages one sync will walk: 20 x 500 = 10k entries,
  // far past any real library, and it stops a server bug from spinning here.
  const MAX_PULL_PAGES = 20;
  // Comfortably under the server's 5 MB body limit, leaving room for the JSON
  // envelope and for an entry growing when escaped.
  const MAX_PUSH_BYTES = 3 * 1024 * 1024;
  const TOMBSTONE_KEY = 'echo-sync-deletions';

  let enabled = false;      // the server has accounts configured
  let signedIn = false;
  let syncing = false;
  let pending = null;       // coalescing timer

  const readJson = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  };
  const writeJson = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  };

  /** Deleting removes the row, so the intent has to be remembered separately. */
  function recordDeletion(videoId) {
    const list = readJson(TOMBSTONE_KEY, []);
    list.push({ videoId, updatedAt: new Date().toISOString(), deleted: true });
    writeJson(TOMBSTONE_KEY, list.slice(-500));
  }

  async function syncNow({ silent = true } = {}) {
    if (!signedIn || syncing) return { skipped: true };
    syncing = true;
    try {
      const cursor = localStorage.getItem(CURSOR_KEY) || '';

      // --- Push: everything this device changed since the last sync ---
      // Which entries changed is decided from the meta store, and only those
      // are then read in full. A sync with nothing to send now costs kilobytes
      // instead of the whole library — and most syncs have nothing to send.
      const meta = await idbGetAllMeta();
      const changedIds = meta
        .filter((m) => !cursor || String(m.updatedAt || '') > cursor)
        .map((m) => m.videoId);
      const changed = [];
      for (const id of changedIds) {
        const entry = await idbGetEntry(id);
        if (entry) changed.push(entry);
      }
      const tombstones = readJson(TOMBSTONE_KEY, []);
      const outgoing = [...changed, ...tombstones];

      // Batched by SIZE, not by count. A library is transcripts: 200 saved
      // videos serialise to ~25 MB, and a request that size is refused by the
      // server's body limit — so an unbatched first sync of any real library
      // failed outright. Entries vary hugely, so counting them is the wrong bound.
      if (outgoing.length > 0) {
        const batches = [];
        let batch = [];
        let batchBytes = 0;

        for (const entry of outgoing) {
          const size = JSON.stringify(entry).length;
          if (size > MAX_PUSH_BYTES) {
            // A single entry bigger than a whole request can never be sent.
            // Skipping it keeps the rest of the library syncing rather than
            // wedging every future sync behind it.
            console.warn('[echo] sync: entry too large to sync, skipping', entry.videoId, size);
            continue;
          }
          if (batchBytes + size > MAX_PUSH_BYTES && batch.length > 0) {
            batches.push(batch);
            batch = [];
            batchBytes = 0;
          }
          batch.push(entry);
          batchBytes += size;
        }
        if (batch.length > 0) batches.push(batch);

        for (const entries of batches) {
          const res = await fetch('/api/sync/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries }),
          });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || 'Sync push failed');
        }

        // Only clear tombstones once EVERY batch is in: a failure partway
        // through must not drop the deletions that never made it.
        writeJson(TOMBSTONE_KEY, []);
      }

      // --- Pull: everything any other device changed ---
      // The server pages its response. Keep asking until it says there is
      // nothing left, or a first sync of a large library would stop after
      // one page and the cursor would skip the rest for good.
      let applied = 0;
      let overwritten = 0;
      let next = cursor;
      for (let page = 0; page < MAX_PULL_PAGES; page++) {
        const pullUrl = next ? `/api/sync/pull?since=${encodeURIComponent(next)}` : '/api/sync/pull';
        const pullRes = await fetch(pullUrl);
        if (!pullRes.ok) throw new Error((await pullRes.json().catch(() => ({}))).error?.message || 'Sync pull failed');
        const { entries = [], serverTime, hasMore } = await pullRes.json();

        for (const remote of entries) {
          const local = await idbGetEntry(remote.videoId);
          // Same rule as the server: strictly newer wins, so a pull cannot
          // clobber an edit made here while the request was in flight.
          if (local && String(local.updatedAt || '') >= String(remote.updatedAt || '')) continue;
          // Last-write-wins is right for one person on two devices, but it
          // is silent: an edit made here can vanish under a newer one from
          // elsewhere with no trace. Count those so the user is told rather
          // than left wondering why their tags changed.
          if (local) overwritten++;
          if (remote.deleted) { await idbDeleteEntryRow(remote.videoId); applied++; continue; }
          await idbPutEntry(remote);
          applied++;
        }

        if (serverTime) { localStorage.setItem(CURSOR_KEY, serverTime); }
        // Stop when the server is done, or if the cursor stopped moving —
        // without that guard a page whose rows all share one timestamp
        // would loop forever.
        if (!hasMore || !serverTime || serverTime === next) break;
        next = serverTime;
      }
      if (applied > 0) {
        // Something arrived from another device — refresh what is on screen.
        try { await loadLibrary(); } catch { /* library view may not be mounted */ }
      }
      // An overwrite is worth reporting even on a background sync: it is the
      // one outcome where something the user did here was replaced.
      if (overwritten > 0) {
        showToast('info',
          `${overwritten} saved video${overwritten === 1 ? '' : 's'} updated from another device.`);
      } else if (!silent) {
        showToast('success', applied > 0 ? `Synced — ${applied} update${applied === 1 ? '' : 's'}` : 'Library is up to date');
      }
      return { applied, overwritten };
    } catch (err) {
      console.error('[echo] sync failed:', err);
      if (!silent) showToast('error', `Sync failed: ${err.message}`);
      return { error: err };
    } finally {
      syncing = false;
    }
  }

  /** Coalesce bursts (saving a video touches the library twice). */
  function schedule() {
    if (!signedIn) return;
    clearTimeout(pending);
    pending = setTimeout(() => syncNow({ silent: true }), 1500);
  }

  /** Ask the server who we are; returns the account state. */
  async function refresh() {
    if (ECHO.mode !== 'web') return { enabled: false, user: null };
    try {
      const res = await fetch('/api/auth/me');
      const body = await res.json();
      enabled = !!body.enabled;
      signedIn = !!(body.user && body.user.email);
      return body;
    } catch {
      enabled = false; signedIn = false;
      return { enabled: false, user: null };
    }
  }

  /** Signing out must not leave another account's library in this browser. */
  function clearLocalSyncState() {
    try {
      localStorage.removeItem(CURSOR_KEY);
      localStorage.removeItem(TOMBSTONE_KEY);
    } catch { /* private mode */ }
  }

  return {
    recordDeletion,
    schedule,
    syncNow,
    refresh,
    clearLocalSyncState,
    get signedIn() { return signedIn; },
    get enabled() { return enabled; },
  };
})();

const IndexedDbLibrary = {
  /** -> meta[], 200 */
  async listEntries() {
    try {
      // The meta store, not the entries: this used to read every transcript in
      // the library to produce a list that shows none of them.
      const all = await idbGetAllMeta();
      all.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
      return idbJson(all, 200);
    } catch (err) { return idbCaughtError(err); }
  },

  /** -> full entry, 200 | 404 */
  async getEntry(videoId) {
    try {
      const entry = await idbGetEntry(videoId);
      if (!entry) return idbErr('Not found.', 404);
      return idbJson(entry, 200);
    } catch (err) { return idbCaughtError(err); }
  },

  /**
   * Upsert an entry by videoId, preserving digest/tags/favorite
   * when the payload omits them — same semantics as
   * store.js's saveEntry(). -> saved meta, 200 | 400
   */
  async saveEntry(payload) {
    try {
      const { url, videoId, title, channel, channelUrl, segments, digest, tags, favorite } = payload || {};
      if (!videoId || !Array.isArray(segments) || segments.length === 0) {
        return idbErr('videoId and segments are required.', 400);
      }
      const now = new Date().toISOString();
      const existing = await idbGetEntry(videoId);

      let entry;
      if (!existing) {
        entry = {
          videoId,
          url:        url || '',
          title:      title || null,
          channel:    channel || null,
          channelUrl: channelUrl || null,
          savedAt:    now,
          updatedAt:  now,
          segments:   segments || [],
          digest:     digest || null,
          favorite:   typeof favorite === 'boolean' ? favorite : false,
          tags:       idbSanitizeTags(tags),
        };
      } else {
        entry = {
          ...existing,
          url:        url != null ? url : existing.url,
          title:      title || null,
          channel:    channel != null ? channel : existing.channel || null,
          channelUrl: channelUrl != null ? channelUrl : existing.channelUrl || null,
          updatedAt:  now,
          segments:   segments || existing.segments,
          digest:     digest ? digest : existing.digest,
          favorite:   typeof favorite === 'boolean' ? favorite : existing.favorite,
          tags:       Array.isArray(tags) ? idbSanitizeTags(tags) : existing.tags,
        };
      }

      await idbPutEntry(entry);
      EchoSync.schedule();
      return idbJson(idbToMeta(entry), 200);
    } catch (err) { return idbCaughtError(err); }
  },

  /** -> { ok:true }, 200 | 404 */
  async deleteEntry(videoId) {
    try {
      const existing = await idbGetEntry(videoId);
      if (!existing) return idbErr('Not found.', 404);
      await idbDeleteEntryRow(videoId);
      // Record a tombstone before the row is gone. Without one, sync has no
      // way to know this was deleted rather than never seen, and the next
      // device to push would resurrect it everywhere.
      EchoSync.recordDeletion(videoId);
      EchoSync.schedule();
      return idbJson({ ok: true }, 200);
    } catch (err) { return idbCaughtError(err); }
  },

  /** -> full entry, 200 | 404 */
  async setTags(videoId, tags) {
    try {
      const existing = await idbGetEntry(videoId);
      if (!existing) return idbErr('Not found.', 404);
      const entry = { ...existing, tags: idbSanitizeTags(tags), updatedAt: new Date().toISOString() };
      await idbPutEntry(entry);
      EchoSync.schedule();
      return idbJson(entry, 200);
    } catch (err) { return idbCaughtError(err); }
  },

  /** -> { entries:[...] }, 200 — consumed unchanged by exportSavedLibrary()'s zip builder */
  async exportAll() {
    try {
      const all = await idbGetAllEntries();
      return idbJson({ entries: all }, 200);
    } catch (err) { return idbCaughtError(err); }
  },

  /** -> markdown text/plain Response, 200 | 404. Built client-side via entryToMarkdownClient(). */
  async entryMarkdown(videoId, opts = {}) {
    try {
      const entry = await idbGetEntry(videoId);
      if (!entry) return idbErr('Not found.', 404);
      const md = entryToMarkdownClient(entry, opts);
      return new Response(md, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } });
    } catch (err) { return idbCaughtError(err); }
  },

  /**
   * Simple client-side keyword filter (web mode has no server-side FTS5
   * index). Used by triggerSearch() in web mode as the search-box
   * backend. Tokenizes the query and matches ANY surviving token — a
   * naive whole-string substring match would almost never hit since
   * real queries are full of stopwords/phrasing that won't appear
   * verbatim in the source text.
   * -> { results, mode }, 200
   */
  async searchLibrary(q, limit = 50) {
    try {
      const tokens = idbFtsTokens(q);
      if (!tokens.length) return idbJson({ results: [], mode: 'keyword' }, 200);
      const capped = Number(limit) || 50;

      // Web mode has no FTS5, so a keyword search has to read the transcripts.
      // What it must NOT do is materialise them. The first version walked a
      // cursor — and then pushed every entry into an array, which put the whole
      // library back in memory — and built a joined, lowercased copy of each
      // transcript (~45 KB a piece) just to run substring tests over it.
      // Measured at 400 entries: 0.8-1.4 s per search, and search runs on a
      // 300 ms keystroke debounce.
      //
      // Three changes, no change in what comes back: score inside the cursor
      // and keep only {videoId, score} (a few bytes per hit, not a transcript);
      // test each field in turn instead of concatenating them; and stop as soon
      // as every token has been found, which is the common case for a query
      // that matches at all. The full entries for the winners are fetched at
      // the end — at most `capped` of them.
      const hits = [];
      await idbForEachEntry((e) => {
        const remaining = new Set(tokens);
        const seek = (value) => {
          if (!value || remaining.size === 0) return;
          const lower = String(value).toLowerCase();
          for (const token of remaining) {
            if (lower.includes(token)) remaining.delete(token);
          }
        };

        // Cheapest fields first: a title or digest hit often settles it.
        seek(e.title);
        seek(e.digest);
        if (remaining.size > 0 && Array.isArray(e.segments)) {
          for (const seg of e.segments) {
            seek(seg && seg.text);
            if (remaining.size === 0) break;
          }
        }

        const score = tokens.length - remaining.size;
        if (score > 0) hits.push({ videoId: e.videoId, score });
      });

      hits.sort((a, b) => b.score - a.score);
      const top = hits.slice(0, capped);
      const results = [];
      for (const hit of top) {
        const entry = await idbGetEntry(hit.videoId);
        if (entry) results.push(entry);
      }
      return idbJson({ results, mode: 'keyword' }, 200);
    } catch (err) { return idbCaughtError(err); }
  },
};

// Local mode uses the server-backed adapter; web mode uses the
// client-side IndexedDB-backed adapter (no server-side store of record).
const Library = (ECHO.mode === 'web') ? IndexedDbLibrary : ServerLibrary;

/* ==============================================
   STATE
=============================================== */
let lastSegments   = null;
let currentSegments = null; // mirrors lastSegments; set on fetch success and openSavedEntry
let sessionCostUsd = 0;
let sessionTokens  = 0;
let indicatorTimer = null;
let currentMeta    = null;  // { videoId, url, title }
let currentDigest  = null;  // string | null
let currentSuggestedTags = []; // string[] — computed server-side alongside the digest, applied at save time

// Saved library state
let savedList           = [];     // full fetched list from /api/saved
let savedSearchQuery    = '';     // current search filter string (client-side)
let savedSortMode       = 'recent'; // 'recent' | 'title'
let savedApiResults     = null;   // { results, mode } from /api/search, or null = use local filter
let savedSearchDebTimer = null;   // debounce timer handle
let savedSearchSeq      = 0;      // monotonic; only the newest search may render
let savedTotal          = 0;      // entries the server reports, incl. pages not fetched yet
let savedLoadSeq        = 0;      // monotonic; abandons a background page-walk when a reload starts

// Find-in-transcript state
let findQuery         = '';
let findMatches       = [];   // Array of <mark> DOM nodes
let findIndex         = -1;
let findDebounceTimer = null;

// Session-restore state (see SESSION RESTORE section near init)
let sessionRestoring = false; // true while replaying a restored session (suppresses re-writes)

// Reading controls state
const READING_SCALES = [0.9, 1.0, 1.15, 1.3];
let readingScaleIdx  = 1;    // default: 1.0
let readingMeasure   = '760px'; // default

// Per-button copy-flash timer tracking (guards against overlapping timers)
const copyTimers = new WeakMap();

/* ==============================================
   ELEMENT REFS
=============================================== */
const pageContainerEl = document.getElementById('pageContainer');
const urlInput        = document.getElementById('urlInput');
// In-flight guard + auto-fetch bookkeeping (replaces the removed "Get transcript" button).
let isFetching       = false;
let lastAutoFetchRef = '';
let autoFetchTimer   = null;
const statusEl        = document.getElementById('status');
const outputEl        = document.getElementById('output');
const radios          = document.querySelectorAll('input[name="viewMode"]');
const digestBtn       = document.getElementById('digestBtn');
const saveBtn         = document.getElementById('saveBtn');
const saveBtnLabel    = document.getElementById('saveBtnLabel');
const digestStatus    = document.getElementById('digestStatus');
const digestOutput    = document.getElementById('digestOutput');
const topIndicator    = document.getElementById('topIndicator');
const paneTranscript  = document.getElementById('paneTranscript');
const paneDigest      = document.getElementById('paneDigest');
const paneSaved       = document.getElementById('paneSaved');
const tabBarEl        = document.getElementById('tabBar');
const tabTranscript   = document.getElementById('tabTranscript');
const tabDigest       = document.getElementById('tabDigest');
const digestDot       = document.getElementById('digestDot');
const digestEmptySt   = document.getElementById('digestEmptyState');
const usageStatsEl    = document.getElementById('usageStats');
const libraryBtn         = document.getElementById('libraryBtn');
const libraryCountEl     = document.getElementById('libraryCount');
const savedOutput        = document.getElementById('savedOutput');
const contentHeaderEl       = document.getElementById('contentHeader');
const contentHeaderThumb    = document.getElementById('contentHeaderThumb');
// A thumbnail YouTube does not have (or that fails to load) hides itself rather
// than leaving a broken-image box in the header. This lived in an onerror
// attribute until it was noticed that the CSP had been refusing it — silently,
// since a blocked inline handler reports to the console and nowhere else.
contentHeaderThumb.addEventListener('error', () => {
  contentHeaderThumb.hidden = true;
  contentHeaderThumb.removeAttribute('src');
});
const contentHeaderTitle    = document.getElementById('contentHeaderTitle');
const contentHeaderUrl      = document.getElementById('contentHeaderUrl');
const contentHeaderDuration = document.getElementById('contentHeaderDuration');
const transcriptSourceBadge = document.getElementById('transcriptSourceBadge');
const transcriptCopyBtn     = document.getElementById('transcriptCopyBtn');
const transcriptDownloadBtn = document.getElementById('transcriptDownloadBtn');
const entryExportBtn        = document.getElementById('entryExportBtn');
const digestExportRow       = document.getElementById('digestExportRow');
const digestCopyBtn         = document.getElementById('digestCopyBtn');
const digestDownloadBtn     = document.getElementById('digestDownloadBtn');
const digestPrintBtn        = document.getElementById('digestPrintBtn');
const digestPrintArea       = document.getElementById('digestPrintArea');
const findInput             = document.getElementById('findInput');
const findCounter           = document.getElementById('findCounter');
const findPrevBtn           = document.getElementById('findPrevBtn');
const findNextBtn           = document.getElementById('findNextBtn');

// Summary panel controls
const digestRegenBtn  = document.getElementById('digestRegenBtn');
const digestLangInput = document.getElementById('digestLangInput');
const digestStopBtn   = document.getElementById('digestStopBtn');

/* ==============================================
   TAB SWITCHING
   Transcript/Digest are lenses on the current video; Saved (the Library)
   is a destination reached via the header Library button — see
   `libraryBtnClick()` below. `lastReaderLens` remembers which lens to
   return to when the Library button is toggled back off.
=============================================== */
let lastReaderLens = 'transcript'; // 'transcript' | 'digest'

function switchTab(name) {
  const names   = ['transcript', 'digest', 'saved'];
  const tabEls  = [tabTranscript, tabDigest, null];
  const paneEls = [paneTranscript, paneDigest, paneSaved];

  names.forEach((n, i) => {
    const active = n === name;
    if (tabEls[i]) {
      tabEls[i].setAttribute('aria-selected', active ? 'true' : 'false');
      tabEls[i].tabIndex = active ? 0 : -1;
    }
    if (paneEls[i]) paneEls[i].hidden  = !active;
  });

  if (name === 'transcript' || name === 'digest') lastReaderLens = name;
  if (name === 'saved') { loadSaved(); }
  if (name === 'digest') hideNextActionNudge();
  libraryBtn.setAttribute('aria-pressed', name === 'saved' ? 'true' : 'false');
  updateReaderChromeVisibility();
  saveSession();
}

/** Toggle the Library destination: open it, or — if already open and a
 *  video is loaded — return to the last reader lens (transcript/digest). */
function libraryBtnClick() {
  const isLibraryActive = !paneSaved.hidden;
  if (isLibraryActive && currentMeta) {
    switchTab(lastReaderLens);
  } else {
    switchTab('saved');
  }
}

/** Show/hide the content header + lens tabs: only while a video is loaded
 *  AND the active pane is a reader lens (not the Library). */
function updateReaderChromeVisibility() {
  const activePane = !paneTranscript.hidden ? 'transcript'
                    : !paneDigest.hidden     ? 'digest'
                    : 'saved';
  const show = !!currentMeta && activePane !== 'saved';
  tabBarEl.hidden       = !show;
  contentHeaderEl.hidden = !show;
}

tabTranscript.addEventListener('click', () => switchTab('transcript'));
tabDigest.addEventListener('click',     () => switchTab('digest'));
libraryBtn.addEventListener('click',    libraryBtnClick);

// Arrow-key roving focus within the lens tab bar (2 tabs)
const tabBtns  = [tabTranscript, tabDigest];
const tabNames = ['transcript', 'digest'];
tabBtns.forEach((btn, i) => {
  btn.addEventListener('keydown', e => {
    let next = null;
    if (e.key === 'ArrowRight') next = (i + 1) % tabBtns.length;
    if (e.key === 'ArrowLeft')  next = (i - 1 + tabBtns.length) % tabBtns.length;
    if (next !== null) {
      e.preventDefault();
      tabBtns[next].focus();
      switchTab(tabNames[next]);
    }
  });
});

/* ==============================================
   SEGMENTED TOGGLE ACTIVE-CLASS (cross-browser :has fallback)
=============================================== */
function syncToggleActive() {
  document.querySelectorAll('.view-toggle label, .digest-seg label').forEach(lbl => {
    lbl.classList.toggle('is-active', lbl.querySelector('input[type="radio"]').checked);
  });
}
syncToggleActive();

/* ==============================================
   STATUS HELPERS
=============================================== */
function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className   = isError ? '' : 'info';
}

function setDigestStatus(msg, isError = false) {
  digestStatus.textContent = msg;
  digestStatus.className   = isError ? '' : 'info';
}

/* ==============================================
   NEXT-ACTION NUDGE — shown once per session after a transcript loads
=============================================== */
const NEXT_ACTION_NUDGE_KEY = 'echo-next-action-nudge-shown';
const nextActionNudgeEl     = document.getElementById('nextActionNudge');

function hideNextActionNudge() {
  if (nextActionNudgeEl) nextActionNudgeEl.hidden = true;
}

function maybeShowNextActionNudge() {
  if (!nextActionNudgeEl) return;
  try {
    if (sessionStorage.getItem(NEXT_ACTION_NUDGE_KEY)) return;
  } catch (e) { /* sessionStorage unavailable — fall through and show once anyway */ }
  nextActionNudgeEl.hidden = false;
  try { sessionStorage.setItem(NEXT_ACTION_NUDGE_KEY, '1'); } catch (e) { /* ignore */ }
}

document.getElementById('nextActionNudgeLink')?.addEventListener('click', e => {
  e.preventDefault();
  switchTab('digest');
});
document.getElementById('nextActionNudgeDismiss')?.addEventListener('click', hideNextActionNudge);

/* ==============================================
   TOAST / BANNER SYSTEM
=============================================== */
const toastContainerEl = document.getElementById('toastContainer');

/**
 * Show a toast notification.
 *
 * @param {'error'|'warning'|'success'|'info'} level
 * @param {string} message  - primary text shown to the user
 * @param {string} [hint]   - optional secondary hint line
 */
function showToast(level, message, hint) {
  if (!toastContainerEl) return;

  const toast     = document.createElement('div');
  toast.className = `toast ${level}`;

  // Errors use role="alert" (assertive); others use role="status" (polite)
  toast.setAttribute('role', level === 'error' ? 'alert' : 'status');

  let html = '<div class="toast-body">';
  html    += `<div class="toast-message">${escapeHtml(message)}</div>`;
  if (hint) html += `<div class="toast-hint">${escapeHtml(hint)}</div>`;
  html    += '</div>';

  // Errors are persistent (manual dismiss); others auto-dismiss
  if (level === 'error') {
    html += '<button class="toast-dismiss" aria-label="Dismiss notification">×</button>';
  }

  toast.innerHTML = html;
  toastContainerEl.appendChild(toast);

  if (level === 'error') {
    toast.querySelector('.toast-dismiss')?.addEventListener('click', () => {
      toast.remove();
    });
  } else {
    const delay = (level === 'success' || level === 'info') ? 3500 : 5500;
    setTimeout(() => toast.remove(), delay);
  }
}

/**
 * Extract a plain string message from the API error envelope.
 * Handles both the new { error: { code, message, hint } } shape and the
 * legacy flat { error: "string" } shape.
 *
 * @param {object} data - parsed response JSON
 * @param {string} [fallback]
 * @returns {string}
 */
function apiErrorMessage(data, fallback) {
  const env = data?.error;
  if (env && typeof env === 'object') return env.message || fallback || 'An error occurred.';
  if (env && typeof env === 'string') return env;
  return fallback || 'An error occurred.';
}

/**
 * Builds a shared reimagined error card DOM node: one human-classified
 * headline + optional next-step hint, with an optional raw machine log
 * tucked behind a collapsible "technical details" disclosure. Used by
 * both the transcript-fetch and digest-generation failure flows —
 * callers append any action buttons (e.g. a "nudge" div) and insert the
 * returned node into their own container.
 *
 * @param {{ headline: string, hint?: string, detail?: string }} opts
 * @returns {HTMLDivElement}
 */
function buildErrorCard({ headline, hint, detail }) {
  const card = document.createElement('div');
  card.className = 'error-card';

  const head = document.createElement('div');
  head.className = 'error-card-head';
  head.textContent = headline;
  card.appendChild(head);

  if (hint) {
    const hintEl = document.createElement('div');
    hintEl.className = 'error-card-hint';
    hintEl.textContent = hint;
    card.appendChild(hintEl);
  }

  if (detail) {
    const details = document.createElement('details');
    details.className = 'error-card-detail';
    const summary = document.createElement('summary');
    summary.textContent = 'Show technical details';
    const pre = document.createElement('pre');
    pre.textContent = detail;
    details.appendChild(summary);
    details.appendChild(pre);
    card.appendChild(details);
  }

  return card;
}

/**
 * Render a reimagined transcript-fetch error into #output: one
 * human-classified headline + next-step hint, with the raw two-strike
 * machine log tucked behind a collapsible "technical details" disclosure.
 * Replaces the old raw-dump + toast pairing for /api/transcript failures.
 *
 * @param {object} data - parsed response JSON (structured error envelope)
 */
function renderTranscriptError(data) {
  console.error('[echo] transcript error:', data);

  const env     = data?.error;
  const headline = env?.message || 'Could not fetch the transcript.';
  const hint     = env?.hint || '';
  const detail   = env?.detail || '';
  const reason   = env?.reason || '';

  setStatus('');

  const card = buildErrorCard({ headline, hint, detail });

  try {
    if (
      reason === 'no_captions' &&
      ECHO.mode !== 'web' &&
      typeof getWhisperMode === 'function' &&
      getWhisperMode() === 'off'
    ) {
      const nudge = document.createElement('div');
      nudge.className = 'error-card-nudge';
      nudge.textContent = 'Tip: enable Whisper transcription in Settings to generate a transcript for videos without captions. ';
      if (typeof openSettingsModal === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Open Settings';
        btn.addEventListener('click', () => openSettingsModal());
        nudge.appendChild(btn);
      }
      card.appendChild(nudge);
    }
  } catch {
    // Whisper helpers unavailable — skip the nudge gracefully.
  }

  outputEl.innerHTML = '';
  outputEl.appendChild(card);
  outputEl.classList.add('visible');

  lastSegments = null;
}

/**
 * Render a reimagined digest-generation error into #digestOutput: same
 * shared error card as renderTranscriptError, with an action button
 * chosen by echoCode ("Open Settings" for auth/key failures where that
 * can actually help, "Try again" for transient/generic failures).
 *
 * @param {object} data - parsed response JSON (structured error envelope)
 */
function renderDigestError(data) {
  console.error('[echo] digest error:', data);

  const env      = data?.error;
  const code     = env?.code;
  let headline   = env?.message || 'Failed to generate the digest.';
  let hint       = env?.hint || '';
  const detail   = env?.detail || '';

  // Desktop-specific: the CLI isn't installed/authed and the user hasn't
  // set a BYOK key yet — point them straight at Settings instead of
  // showing the generic (CLI-oriented) error.
  if (
    (code === 'CLAUDE_NOT_INSTALLED' || code === 'CLAUDE_NOT_AUTHED') &&
    ECHO.mode === 'desktop' &&
    !getApiKey()
  ) {
    headline = 'AI features need a key or the Claude CLI';
    hint     = 'Add your Anthropic API key in Settings, or install & sign in to the Claude Code CLI.';
  }

  const card = buildErrorCard({ headline, hint, detail });

  try {
    const settingsCanHelp =
      code === 'CLAUDE_NOT_INSTALLED' ||
      code === 'CLAUDE_NOT_AUTHED' ||
      code === 'API_NOT_AUTHED';
    const retryable =
      code === 'API_RATE_LIMITED' ||
      code === 'RATE_LIMITED' ||
      code === 'API_FAILED' ||
      code === 'CLAUDE_FAILED' ||
      code === 'INTERNAL' ||
      !code;

    if (settingsCanHelp && (ECHO.mode !== 'local' || code === 'API_NOT_AUTHED')) {
      if (typeof openSettingsModal === 'function') {
        const nudge = document.createElement('div');
        nudge.className = 'error-card-nudge';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Open Settings';
        btn.addEventListener('click', () => openSettingsModal());
        nudge.appendChild(btn);
        card.appendChild(nudge);
      }
    } else if (retryable) {
      if (typeof runDigest === 'function') {
        const nudge = document.createElement('div');
        nudge.className = 'error-card-nudge';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Try again';
        btn.addEventListener('click', () => runDigest());
        nudge.appendChild(btn);
        card.appendChild(nudge);
      }
    }
  } catch {
    // Action-button helpers unavailable — skip gracefully.
  }

  setDigestStatus('');
  digestEmptySt.classList.add('is-hidden');
  digestOutput.innerHTML = '';
  digestOutput.appendChild(card);
  digestOutput.classList.add('visible');
}

/**
 * Parse a structured API error envelope and show an error toast.
 * Also logs to console for debugging.
 *
 * @param {object} data - parsed response JSON
 * @param {string} [fallback] - fallback message if envelope is missing
 */
function handleApiError(data, fallback) {
  console.error('[echo] API error:', data);

  const env = data?.error;
  let message, hint;

  // Desktop-specific: the CLI isn't installed/authed and the user hasn't
  // set a BYOK key yet — point them straight at Settings instead of
  // showing the generic (CLI-oriented) error.
  const code = env && typeof env === 'object' ? env.code : undefined;
  if (
    (code === 'CLAUDE_NOT_INSTALLED' || code === 'CLAUDE_NOT_AUTHED') &&
    ECHO.mode === 'desktop' &&
    !getApiKey()
  ) {
    showToast(
      'error',
      'Claude CLI not found — add your Anthropic API key in Settings to use AI features, or install the Claude CLI.',
      ''
    );
    openSettingsModal();
    return;
  }

  if (env && typeof env === 'object') {
    message = env.message || fallback || 'An error occurred.';
    hint    = env.hint    || '';
  } else if (env && typeof env === 'string') {
    // Legacy flat shape (transitional)
    message = env;
    hint    = data.detail || '';
  } else {
    message = fallback || 'An unexpected error occurred.';
    hint    = '';
  }

  showToast('error', message, hint);
}

/* ==============================================
   TOP INDICATOR
=============================================== */
function setTopIndicator(state) {
  clearTimeout(indicatorTimer);

  // Reset
  topIndicator.className   = '';
  topIndicator.onclick     = null;
  topIndicator.onkeydown   = null;
  topIndicator.innerHTML   = '';
  topIndicator.removeAttribute('tabindex');
  topIndicator.removeAttribute('role');

  // Drive the ambient "Signal Surface" background glow: it comes alive
  // (intensifies + breathes) while a digest is in flight.
  document.body.classList.toggle('ai-active', state === 'digesting');

  if (state === 'idle') return;

  topIndicator.classList.add('visible');

  if (state === 'digesting') {
    topIndicator.classList.add('digesting');
    topIndicator.innerHTML = '<span class="indicator-dot" aria-hidden="true"></span>AI is digesting…';

  } else if (state === 'done') {
    topIndicator.classList.add('done');
    topIndicator.innerHTML = 'Digest ready ✓';
    topIndicator.setAttribute('tabindex', '0');
    topIndicator.setAttribute('role', 'button');
    const activate = () => {
      switchTab('digest');
      setTopIndicator('idle');
    };
    topIndicator.onclick   = activate;
    topIndicator.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    };
    // Auto-dismiss after 2500ms
    indicatorTimer = setTimeout(() => setTopIndicator('idle'), 2500);

  } else if (state === 'error') {
    topIndicator.classList.add('error');
    topIndicator.innerHTML = 'Digest failed';
    // Auto-dismiss after 2500ms
    indicatorTimer = setTimeout(() => setTopIndicator('idle'), 2500);
  }
}

/* ==============================================
   USAGE FORMATTING HELPERS
=============================================== */
function formatTokens(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function formatCostUsd(usd) {
  if (usd == null) return null;
  return '$' + usd.toFixed(2);
}

/* ==============================================
   PER-DIGEST + SESSION USAGE DISPLAY
=============================================== */
function renderUsageStats(u) {
  if (!u) return;

  // Accumulate session totals (called once per successful digest)
  if (u.totalTokens != null) sessionTokens  += u.totalTokens;
  if (u.costUsd     != null) sessionCostUsd += u.costUsd;

  // This-digest line
  const digestParts = [
    '<span class="mono">' + formatTokens(u.totalTokens) + ' tokens</span>',
  ];
  const thisCost = formatCostUsd(u.costUsd);
  if (thisCost) digestParts.push('<span class="mono">' + thisCost + '</span>');
  if (u.durationMs != null) {
    digestParts.push('<span class="mono">' + Math.round(u.durationMs / 1000) + 's</span>');
  }

  // Session line
  const sessCost   = formatCostUsd(sessionCostUsd) || '$0.00';
  const sessTokens = formatTokens(sessionTokens);
  const sessLine   =
    '<span class="mono">' + sessCost + '</span>' +
    ' &middot; <span class="mono">' + sessTokens + ' tokens</span>';

  usageStatsEl.innerHTML =
    '<div class="usage-line">This digest &middot; ' + digestParts.join(' &middot; ') + '</div>' +
    '<div class="usage-line">Session &middot; ' + sessLine + '</div>';
  usageStatsEl.classList.add('visible');
}

/* ==============================================
   CORE TRANSCRIPT UTILITIES
=============================================== */
function formatTime(seconds) {
  const s  = Math.floor(seconds);
  const m  = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

/** Rough human-readable duration ("~52m" or "~1:05") from a segment offset in seconds. */
function formatDurationHuman(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
  if (totalSeconds >= 3600) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.round((totalSeconds % 3600) / 60);
    return `~${h}:${String(m).padStart(2, '0')}`;
  }
  return `~${Math.max(Math.round(totalSeconds / 60), 1)}m`;
}

function getMode() {
  return [...radios].find(r => r.checked)?.value ?? 'plain';
}

/**
 * Reflows an array of { text, offset } segments into an array of paragraph strings.
 *
 * Paragraph breaks happen at sentence boundaries (., ?, ! optionally followed by
 * a closing quote/paren) using two signals:
 *   A) Accumulated buffer >= 350 chars AND segment ends at a sentence terminator.
 *   B) Pause to the next segment >= 3 s AND buffer ends at a sentence terminator
 *      AND buffer is already non-trivial (>= 80 chars).
 *
 * Fallback: if there is only one giant paragraph with no sentence punctuation at all
 * (e.g. auto-captions without punctuation), hard-wrap every ~500 chars at a space.
 */
function reflowToParagraphs(segments) {
  if (!segments || segments.length === 0) return [];

  // Matches a sentence-terminating end: . ? ! optionally followed by closing quote/paren
  const sentenceEnd = /[.?!]["')]*\s*$/;

  const paragraphs = [];
  let buffer = '';

  for (let i = 0; i < segments.length; i++) {
    // Clean segment text: collapse internal newlines and runs of whitespace
    const cleaned = segments[i].text
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) continue;

    // Append to buffer with a single joining space
    buffer = buffer ? buffer + ' ' + cleaned : cleaned;

    const isLast = i === segments.length - 1;

    // Signal A: length threshold reached at a sentence boundary
    if (buffer.length >= 350 && sentenceEnd.test(buffer)) {
      paragraphs.push(buffer.trim());
      buffer = '';
      continue;
    }

    // Signal B: notable timing pause before the next segment at a sentence boundary
    if (!isLast) {
      const gap = segments[i + 1].offset - segments[i].offset;
      if (gap >= 3 && buffer.length >= 80 && sentenceEnd.test(buffer)) {
        paragraphs.push(buffer.trim());
        buffer = '';
        continue;
      }
    }
  }

  // Push any remaining text as the final paragraph
  if (buffer.trim()) {
    paragraphs.push(buffer.trim());
  }

  // Fallback: single paragraph with no sentence punctuation — hard-wrap at ~500 chars
  if (paragraphs.length === 1 && !/[.?!]/.test(paragraphs[0])) {
    const raw    = paragraphs[0];
    const chunks = [];
    let pos = 0;
    while (pos < raw.length) {
      if (pos + 500 >= raw.length) {
        chunks.push(raw.slice(pos).trim());
        break;
      }
      // Walk back from pos+500 to find the nearest space to break on
      let cut = pos + 500;
      while (cut > pos && raw[cut] !== ' ') cut--;
      if (cut === pos) cut = pos + 500; // no space found — hard cut
      chunks.push(raw.slice(pos, cut).trim());
      pos = cut + 1;
    }
    return chunks.filter(Boolean);
  }

  return paragraphs;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// For use in HTML attribute values (double-quoted)
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Returns the URL only if it is a safe http(s) URL, else ''.
// Browsers ignore leading/trailing whitespace and embedded control chars
// (tab/newline/CR) when resolving a scheme, so strip those before testing.
function safeHttpUrl(raw) {
  if (raw == null) return '';
  const cleaned = String(raw).replace(/\s+/g, '');
  return /^https?:\/\//i.test(cleaned) ? cleaned : '';
}

function renderSegments(segments) {
  if (!segments || segments.length === 0) {
    outputEl.textContent = '(No transcript segments returned.)';
    outputEl.classList.add('visible');
    return;
  }

  if (getMode() === 'plain') {
    // Reflow fragments into readable paragraphs; each becomes a <p> element
    const paras = reflowToParagraphs(segments);
    outputEl.innerHTML = paras
      .map(p => `<p>${escapeHtml(p)}</p>`)
      .join('');
  } else {
    // Timecoded mode: gutter layout — timecode left, caption text right
    const vid = currentMeta?.videoId || null;
    outputEl.innerHTML = segments.map(s => {
      const tc = formatTime(s.offset);
      const t  = Math.floor(s.offset);
      const badge = vid
        ? `<a class="ts-badge ts-link"
              href="https://www.youtube.com/watch?v=${escapeAttr(vid)}&t=${t}s"
              target="_blank" rel="noopener noreferrer"
              aria-label="Jump to ${escapeAttr(tc)}">${tc}</a>`
        : `<span class="ts-badge">${tc}</span>`;
      return `<div class="ts-line">${badge}<span class="ts-text">${escapeHtml(s.text)}</span></div>`;
    }).join('');
  }

  outputEl.classList.add('visible');
}

/* ==============================================
   CONTENT HEADER — thumbnail + title/meta for the currently-loaded video
=============================================== */
function updateNowReading() {
  // Single source of truth for "a transcript is currently loaded" —
  // drives visibility of the reading controls / find bar / lang picker
  // via the `has-transcript` CSS gate (see section 18b).
  document.body.classList.toggle('has-transcript', !!currentMeta);
  if (!currentMeta) {
    contentHeaderThumb.hidden = true;
    contentHeaderThumb.removeAttribute('src');
    contentHeaderTitle.textContent    = '';
    contentHeaderUrl.textContent      = '';
    contentHeaderUrl.removeAttribute('href');
    contentHeaderDuration.textContent = '';
    if (transcriptSourceBadge) transcriptSourceBadge.hidden = true;
    updateReaderChromeVisibility();
    return;
  }

  contentHeaderTitle.textContent = currentMeta.title || currentMeta.videoId;

  const safeUrl = safeHttpUrl(currentMeta.url);
  contentHeaderUrl.textContent = currentMeta.url;
  if (safeUrl) {
    contentHeaderUrl.href = safeUrl;
  } else {
    contentHeaderUrl.removeAttribute('href');
  }

  // Thumbnail — only fetched when the URL passed the safe-URL check.
  if (safeUrl && currentMeta.videoId) {
    contentHeaderThumb.src   = `https://i.ytimg.com/vi/${encodeURIComponent(currentMeta.videoId)}/mqdefault.jpg`;
    contentHeaderThumb.hidden = false;
  } else {
    contentHeaderThumb.hidden = true;
    contentHeaderThumb.removeAttribute('src');
  }

  // Duration — reuse the same humanized calc as the status line, derived
  // from the currently-loaded segments (mirrors lastSegments).
  const segs = currentSegments || lastSegments;
  const lastSeg = Array.isArray(segs) && segs.length ? segs[segs.length - 1] : null;
  const durationStr = lastSeg && typeof lastSeg.offset === 'number'
    ? formatDurationHuman(lastSeg.offset)
    : '';
  contentHeaderDuration.textContent = durationStr
    ? (contentHeaderUrl.textContent ? ' · ' + durationStr : durationStr)
    : '';

  // Source badge — reflects how this transcript was obtained (YouTube
  // captions vs. on-device Whisper). Set on currentMeta by the fetch
  // success path, the saved-entry open path, and session restore.
  if (transcriptSourceBadge) {
    const source = currentMeta.transcriptSource || 'captions';
    transcriptSourceBadge.textContent = source === 'whisper' ? 'Whisper' : 'YouTube captions';
    transcriptSourceBadge.hidden = false;
  }

  updateReaderChromeVisibility();
}

/* ==============================================
   COPY / DOWNLOAD HELPERS  (Feature 1)
=============================================== */
/**
 * Write `text` to the clipboard and briefly change btn label to "Copied ✓".
 * `origLabel` is the stable label to restore; guards against overlapping timers.
 */
function copyToClipboard(btn, text, origLabel) {
  if (!navigator.clipboard) return;
  clearTimeout(copyTimers.get(btn));
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied ✓';
    const t = setTimeout(() => { btn.textContent = origLabel; }, 1500);
    copyTimers.set(btn, t);
  }).catch(() => { /* clipboard access denied — silently skip */ });
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function downloadMd(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename + '.md';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Fetch a saved entry's Markdown export from the server and trigger a
 * browser download. Reuses the toast + error-envelope conventions.
 */
async function exportEntryMd(videoId, title) {
  try {
    const res = await Library.entryMarkdown(videoId);
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      if (d) return handleApiError(d);
      return showToast('error', 'Export failed');
    }
    const text = await res.text();
    downloadMd(slugify(title || 'echo-entry') || 'echo-entry', text);
    showToast('success', 'Exported Markdown');
  } catch (e) {
    showToast('error', 'Export failed', String(e && e.message || e));
  }
}

/** Show or hide the digest export row based on whether a digest exists. */
function syncDigestExportRow() {
  digestExportRow.hidden = !currentDigest;
}

/**
 * Sync the Generate/Regenerate button in the Summary panel.
 * - Enabled whenever a transcript is loaded.
 * - Label is "Generate digest" when no digest exists yet, "Regenerate" otherwise.
 */
function syncDigestRegenBtn() {
  const hasTranscript = !!(lastSegments && lastSegments.length > 0);
  digestRegenBtn.disabled   = !hasTranscript;
  digestRegenBtn.textContent = currentDigest ? 'Regenerate' : 'Generate digest';
}

/* --- Transcript copy / download --- */
transcriptCopyBtn.addEventListener('click', () => {
  if (!lastSegments) return;
  let text;
  if (getMode() === 'plain') {
    const paras = reflowToParagraphs(lastSegments);
    text = paras.join('\n\n');
  } else {
    text = lastSegments
      .map(s => `[${formatTime(s.offset)}] ${s.text.replace(/[\r\n]+/g, ' ').trim()}`)
      .join('\n');
  }
  copyToClipboard(transcriptCopyBtn, text, 'Copy');
});

transcriptDownloadBtn.addEventListener('click', () => {
  if (!lastSegments) return;
  const title     = currentMeta?.title || 'Transcript';
  const sourceUrl = currentMeta?.url   || '';
  const paras     = reflowToParagraphs(lastSegments);
  const body      = paras.join('\n\n');
  const md        = `# ${title}\n\nSource: ${sourceUrl}\n\n${body}`;
  const slug      = slugify(title) || 'echo-transcript';
  downloadMd(slug, md);
});

entryExportBtn.addEventListener('click', () => {
  if (!currentMeta?.videoId) return;
  exportEntryMd(currentMeta.videoId, currentMeta.title);
});

/* --- Digest copy / download --- */
digestCopyBtn.addEventListener('click', () => {
  if (!currentDigest) return;
  copyToClipboard(digestCopyBtn, currentDigest, 'Copy');
});

digestDownloadBtn.addEventListener('click', () => {
  if (!currentDigest) return;
  const title     = currentMeta?.title || 'Digest';
  const sourceUrl = currentMeta?.url   || '';
  const md        = `# ${title}\n\nSource: ${sourceUrl}\n\n${currentDigest}`;
  const slug      = (slugify(title) || 'echo') + '-digest';
  downloadMd(slug, md);
});

/**
 * Print the current digest (or "Save as PDF" via the browser print
 * dialog). Renders title + source + digest body into the hidden
 * #digestPrintArea, toggles a body class the "@media print" stylesheet
 * uses to hide everything else, then calls window.print(). The body
 * class is removed on the browser's `afterprint` event so a cancelled
 * print dialog doesn't leave the app in a print-only state.
 */
function printDigest() {
  if (!currentDigest || !digestPrintArea) return;
  const title     = currentMeta?.title || 'Digest';
  const sourceUrl = currentMeta?.url   || '';
  digestPrintArea.innerHTML =
    '<div class="digest-print-title">' + escapeHtml(title) + '</div>' +
    (sourceUrl ? '<div class="digest-print-source">' + escapeHtml(sourceUrl) + '</div>' : '') +
    renderMarkdown(currentDigest);
  document.body.classList.add('printing-digest');
  window.print();
}

function stopPrintingDigest() {
  document.body.classList.remove('printing-digest');
}

digestPrintBtn?.addEventListener('click', printDigest);
// afterprint fires whether the user prints or cancels the dialog — either
// way we want to restore the normal on-screen view.
window.addEventListener('afterprint', stopPrintingDigest);

/* ==============================================
   FIND IN TRANSCRIPT  (Feature 3)
=============================================== */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Clear the find input and remove all highlights. */
function resetFind() {
  clearTimeout(findDebounceTimer);
  findQuery       = '';
  findInput.value = '';
  clearFindHighlights();
}

/** Remove all <mark class="find-hit"> wrappers, re-merge text nodes. */
function clearFindHighlights() {
  outputEl.querySelectorAll('mark.find-hit').forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
  findMatches             = [];
  findIndex               = -1;
  findCounter.textContent = '';
}

/**
 * Walk text nodes under outputEl and wrap all case-insensitive occurrences of
 * `query` in <mark class="find-hit">.  Does NOT use innerHTML replace so
 * existing element tags (links, spans) are never corrupted.
 */
function applyFindHighlights(query) {
  clearFindHighlights();
  if (!query) return;

  const regex = new RegExp(escapeRegex(query), 'gi');

  // Collect text nodes up front to avoid live-mutation issues during iteration
  const walker = document.createTreeWalker(
    outputEl,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const tag = node.parentElement?.tagName?.toLowerCase();
        if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT;
        // Skip text already inside a find-hit mark (none should exist here)
        if (node.parentElement?.closest('mark.find-hit')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  for (const textNode of textNodes) {
    const text = textNode.textContent;
    regex.lastIndex = 0;
    if (!regex.test(text)) continue;
    regex.lastIndex = 0;

    const frag  = document.createDocumentFragment();
    let lastIdx = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
      }
      const mark       = document.createElement('mark');
      mark.className   = 'find-hit';
      mark.textContent = match[0];
      frag.appendChild(mark);
      findMatches.push(mark);
      lastIdx = match.index + match[0].length;
    }

    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }

    textNode.parentNode.replaceChild(frag, textNode);
  }

  if (findMatches.length > 0) {
    findIndex = 0;
    activateFindMatch(0);
  } else {
    updateFindCounter();
  }
}

function updateFindCounter() {
  if (!findQuery) {
    findCounter.textContent = '';
    return;
  }
  if (findMatches.length === 0) {
    findCounter.textContent = 'No matches';
    return;
  }
  findCounter.textContent = `${findIndex + 1}/${findMatches.length}`;
}

function activateFindMatch(idx) {
  findMatches.forEach((m, i) => m.classList.toggle('active', i === idx));
  if (findMatches[idx]) {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    findMatches[idx].scrollIntoView({
      block:    'center',
      behavior: reduced ? 'auto' : 'smooth',
    });
  }
  updateFindCounter();
}

function findNext() {
  if (findMatches.length === 0) return;
  findIndex = (findIndex + 1) % findMatches.length;
  activateFindMatch(findIndex);
}

function findPrev() {
  if (findMatches.length === 0) return;
  findIndex = (findIndex - 1 + findMatches.length) % findMatches.length;
  activateFindMatch(findIndex);
}

findInput.addEventListener('input', () => {
  clearTimeout(findDebounceTimer);
  findDebounceTimer = setTimeout(() => {
    findQuery = findInput.value;
    applyFindHighlights(findQuery);
  }, 120);
});

findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) findPrev(); else findNext();
  }
});

findPrevBtn.addEventListener('click', findPrev);
findNextBtn.addEventListener('click', findNext);

/* ==============================================
   READING CONTROLS — FEATURE A
=============================================== */
function applyReadingStyles() {
  const scale = READING_SCALES[readingScaleIdx];
  // Applied on the shared page container (ancestor of #contentHeader,
  // #tabBar, #paneTranscript and #paneDigest) so --reading-measure
  // inherits down to every reader-column element — content header,
  // lens tabs, reader toolbars, transcript output AND the digest pane
  // (digestOutput) — keeping them all aligned to the same
  // reading measure. --reading-scale is
  // only consumed inside #output/#digestOutput, but setting
  // it at the same level is harmless and keeps this one function the
  // single source of truth — see FEATURE A/C shared-state note.
  const el = pageContainerEl || document.documentElement;
  el.style.setProperty('--reading-scale', scale);
  el.style.setProperty('--reading-measure', readingMeasure);
}

function syncReadingControls() {
  const decBtns = document.querySelectorAll('[data-reading-action="dec"]');
  const incBtns = document.querySelectorAll('[data-reading-action="inc"]');
  decBtns.forEach(btn => { btn.disabled = readingScaleIdx <= 0; });
  incBtns.forEach(btn => { btn.disabled = readingScaleIdx >= READING_SCALES.length - 1; });
  syncMeasureActive();
}

function syncMeasureActive() {
  document.querySelectorAll('.reading-measure-seg label').forEach(lbl => {
    const inp = lbl.querySelector('input[type="radio"]');
    if (inp) lbl.classList.toggle('is-active', inp.checked);
  });
}

// Init: restore persisted reading settings, apply early to avoid layout shift
(function initReadingControls() {
  const savedScale   = localStorage.getItem('echo-reading-scale');
  const savedMeasure = localStorage.getItem('echo-reading-measure');

  if (savedScale != null) {
    const idx = READING_SCALES.indexOf(parseFloat(savedScale));
    if (idx !== -1) readingScaleIdx = idx;
  }
  if (savedMeasure && ['620px', '760px', '940px'].includes(savedMeasure)) {
    readingMeasure = savedMeasure;
    // Sync radio to persisted value
    const inp = document.querySelector(`input[name="readingMeasure"][value="${savedMeasure}"]`);
    if (inp) inp.checked = true;
  }

  applyReadingStyles();
  syncReadingControls();
})();

// Font-size buttons — wired for every cluster on the page (Transcript + Digest)
document.querySelectorAll('[data-reading-action="dec"]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (readingScaleIdx > 0) {
      readingScaleIdx--;
      localStorage.setItem('echo-reading-scale', READING_SCALES[readingScaleIdx]);
      applyReadingStyles();
      syncReadingControls();
    }
  });
});

document.querySelectorAll('[data-reading-action="inc"]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (readingScaleIdx < READING_SCALES.length - 1) {
      readingScaleIdx++;
      localStorage.setItem('echo-reading-scale', READING_SCALES[readingScaleIdx]);
      applyReadingStyles();
      syncReadingControls();
    }
  });
});

// Measure (line-width) radios
document.querySelectorAll('input[name="readingMeasure"]').forEach(r => {
  r.addEventListener('change', () => {
    readingMeasure = r.value;
    localStorage.setItem('echo-reading-measure', readingMeasure);
    applyReadingStyles();
    syncMeasureActive();
  });
});

/**
 * Re-apply the active find query after any re-render.
 * Call this every time renderSegments() is called.
 */
function reApplyOverlays() {
  clearFindHighlights();
  if (findQuery) applyFindHighlights(findQuery);
}

/* --- Keyboard: Esc closes any open overlay ---
   Any visible [role="dialog"] modal — using its known close handler where
   one exists, otherwise just hiding it. This generically covers new
   overlays without needing a hardcoded id list. */
const DIALOG_CLOSE_FNS = {
  shortcutsOverlay:   closeShortcutsOverlay,
  settingsOverlay:    closeSettingsModal,
  legalOverlay:       closeLegalOverlay,
};
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;

  const openDialog = document.querySelector('[role="dialog"]:not([hidden])');
  if (openDialog) {
    const closeFn = DIALOG_CLOSE_FNS[openDialog.id];
    if (closeFn) closeFn(); else openDialog.hidden = true;
  }
});

/* ==============================================
   FETCH TRANSCRIPT
=============================================== */
/**
 * Apply a loaded transcript response to the UI. Shared by the YouTube path
 * (POST /api/transcript) and the local-file path (POST /api/transcript/file),
 * which return the same envelope — so everything downstream of "we have
 * segments" behaves identically no matter where the audio came from.
 *
 * @param {object} data - the transcript response envelope
 */
function applyTranscriptResponse(data) {
  lastSegments    = data.segments;
  currentSegments = data.segments;
  const transcriptSource = data.transcriptSource || 'captions';
  currentMeta     = {
    videoId: data.videoId, url: data.url, title: data.title,
    channel: data.channel || null, channelUrl: data.channelUrl || null,
    // Prefer the model the server says actually ran: a non-English video on
    // `base` is upgraded to `small` server-side, so the local picker's value
    // would record a model that never touched this audio.
    transcriptSource,
    whisperModel: transcriptSource === 'whisper' ? (data.whisperModel || getWhisperModel()) : null,
  };
  currentDigest   = null;
  currentSuggestedTags = [];
  // The server reports which caption track was actually loaded (not
  // just the language that was requested) — the picker uses this to
  // pre-select the right option instead of falling back to whatever
  // sorts first alphabetically. See loadLanguageTracks() below.
  currentLangCode = data.langCode || null;
  updateNowReading();
  syncDigestExportRow();

  {
    const lastSeg      = data.segments[data.segments.length - 1];
    const durationStr  = lastSeg && typeof lastSeg.offset === 'number'
      ? formatDurationHuman(lastSeg.offset)
      : '';
    setStatus(
      `Transcript loaded — ${data.segments.length} segments` +
      (durationStr ? ` · ${durationStr}` : '')
    );
  }
  renderSegments(lastSegments);
  maybeShowNextActionNudge();
  markOnboarded(); // a successful fetch means the user is past first-run
  saveSession();

  // Async: if this video is already saved, enable the export button
  (function enableExportIfSaved(videoId) {
    Library.getEntry(videoId)
      .then(r => r.ok ? r.json() : null)
      .then(entry => {
        if (entry && currentMeta && currentMeta.videoId === videoId) {
          entryExportBtn.disabled = false;
        }
      })
      .catch(() => {});
  })(data.videoId);

  digestBtn.disabled              = false;
  saveBtn.disabled                = false;
  syncSaveButton(); // reflect whether this video is already in the library
  transcriptCopyBtn.disabled      = false;
  transcriptDownloadBtn.disabled  = false;
  syncDigestRegenBtn(); // update label + enable state based on transcript & digest state

  // Async (non-blocking): load caption language tracks for the picker.
  // Skipped for a local file — there is no YouTube video to list tracks
  // for, and /api/languages would reject the synthetic id anyway.
  if (!data.localFile) loadLanguageTracks(data.videoId);

  // Auto-generate the AI digest if enabled (Echo's default behavior).
  // In web mode, silently skip when no API key is set to avoid popping
  // the settings modal right after the transcript loads.
  if (getAutoDigest() && (ECHO.mode !== 'web' || getApiKey())) {
    Promise.resolve(runDigest()).catch(err => console.error('[echo] auto-digest error:', err));
  }
}

/* ==============================================
   LOCAL MEDIA — transcribe a file the user picks
   Same Whisper stage, same response envelope, same UI afterwards; only the
   source of the audio differs. Local/desktop only (the route is blockInWeb),
   and gated further on Whisper actually being usable — offering a file
   picker that can only fail is worse than not offering one.
=============================================== */
async function fetchLocalFile(file) {
  if (!file) return;
  if (isFetching) return;
  isFetching = true;

  const noteEl = document.getElementById('localFileNote');
  const setNote = (text) => { if (noteEl) noteEl.textContent = text; };

  // Same reset the URL path does, so a file load doesn't inherit the
  // previous video's digest, language picker, or export state.
  currentDigest = null;
  digestOutput.innerHTML = '';
  digestOutput.classList.remove('visible');
  usageStatsEl.innerHTML = '';
  digestDot.classList.add('is-hidden');
  setTopIndicator('idle');
  switchTab('transcript');
  currentLangCode = null;
  outputEl.classList.remove('visible');
  outputEl.innerHTML = '';

  const jobId = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  const stopProgress = startWhisperProgress(jobId);

  setNote(`${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`);
  setStatus('Transcribing… (this runs on your machine and can take a few minutes)');

  try {
    const params = new URLSearchParams({ name: file.name, jobId });
    const model = getWhisperModel();
    if (model) params.set('whisperModel', model);

    // The File goes up as the raw body — no multipart, no upload library.
    const res = await fetch(`/api/transcript/file?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    const data = await res.json();

    if (!res.ok) {
      renderTranscriptError(data);
      setNote('');
      return;
    }

    applyTranscriptResponse(data);
  } catch (err) {
    console.error('[echo] local file transcription error:', err);
    setStatus('Could not transcribe that file.', true);
    showToast('error', 'Transcription failed: ' + err.message);
    outputEl.classList.remove('visible');
    outputEl.innerHTML = '';
    setNote('');
  } finally {
    if (stopProgress) stopProgress();
    isFetching = false;
  }
}

(function initLocalFile() {
  const row = document.getElementById('localFileRow');
  const btn = document.getElementById('localFileBtn');
  const input = document.getElementById('localFileInput');
  if (!row || !btn || !input) return;

  // Web mode has no Whisper at all — the route 503s there.
  if (ECHO.mode === 'web') return;

  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    // Reset so picking the SAME file twice still fires a change event.
    input.value = '';
    fetchLocalFile(file);
  });

  // Only reveal the row once Whisper can actually run: the binary is
  // present AND a model is downloaded. Otherwise the picker is a trap that
  // ends in "download a model first".
  fetch('/api/whisper/status')
    .then(r => (r.ok ? r.json() : null))
    .then(status => {
      if (!status || !status.binaryPresent) return;
      const ready = Array.isArray(status.models) && status.models.some(m => m.present);
      if (ready) row.hidden = false;
    })
    .catch(() => { /* status unavailable — leave the row hidden */ });
})();

async function fetchTranscript() {
  const url = urlInput.value.trim();
  if (!url) { setStatus('Please enter a YouTube URL or video ID.', true); return; }
  if (isFetching) return; // guard against overlapping fetches
  lastAutoFetchRef = url; // dedupe key so auto-triggers don't re-fire the same URL

  isFetching = true;
  outputEl.classList.remove('visible');
  showTranscriptSkeleton();

  // Reset meta state on new fetch
  currentMeta       = null;
  currentDigest     = null;
  currentSuggestedTags = [];
  currentSegments   = null;
  clearSession(); // new fetch in flight — drop any stale prior-video snapshot
  updateNowReading();
  syncDigestExportRow();
  resetFind();
  transcriptCopyBtn.disabled     = true;
  transcriptDownloadBtn.disabled = true;
  entryExportBtn.disabled        = true;

  // Reset digest / AI workspace completely on a new fetch
  digestBtn.disabled      = true;
  digestRegenBtn.disabled = true;
  digestRegenBtn.textContent = 'Generate digest'; // reset label for new video
  saveBtn.disabled        = true;
  digestOutput.classList.remove('visible');
  digestOutput.innerHTML    = '';
  stopDigestTimer();
  digestStatus.textContent  = '';
  digestStatus.className    = '';
  digestEmptySt.classList.remove('is-hidden');
  usageStatsEl.classList.remove('visible');
  usageStatsEl.innerHTML    = '';
  digestDot.classList.add('is-hidden');
  setTopIndicator('idle');
  switchTab('transcript');

  // Reset language picker for the new video
  currentLangCode = null;
  const _lpWrap   = document.getElementById('langPickerWrap');
  const _lpSel    = document.getElementById('langSelect');
  const _lpStatus = document.getElementById('langPickerStatus');
  if (_lpWrap)   { _lpWrap.hidden = true; }
  if (_lpSel)    { _lpSel.innerHTML = ''; }
  if (_lpStatus) { _lpStatus.textContent = ''; _lpStatus.className = 'lang-picker-status'; }

  const whisperMode = getWhisperMode();
  setStatus(whisperMode !== 'off'
    ? 'Fetching transcript… (Whisper may take a few minutes)'
    : 'Fetching transcript…');

  // Clear any prior error card / output while the new fetch is in flight.
  outputEl.classList.remove('visible');
  outputEl.innerHTML = '';

  // Live Whisper progress: give the server a jobId and subscribe to its SSE
  // channel. The progress card only appears if Whisper actually runs (no
  // captions) — caption hits return before any progress tick fires.
  const jobId = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  let stopProgress = null;
  if (whisperMode !== 'off' && ECHO.mode !== 'web') {
    stopProgress = startWhisperProgress(jobId);
  }

  try {
    const res  = await fetch('/api/transcript', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url, transcribe: whisperMode, whisperModel: getWhisperModel(), jobId }),
    });
    const data = await res.json();

    if (!res.ok) {
      renderTranscriptError(data);
      return;
    }

    applyTranscriptResponse(data);
  } catch (err) {
    console.error('[echo] fetchTranscript network error:', err);
    setStatus('Network error — could not reach the server.', true);
    showToast('error', 'Network error: ' + err.message);
    outputEl.classList.remove('visible');
    outputEl.innerHTML = '';
    lastSegments = null;
  } finally {
    if (stopProgress) stopProgress();
    isFetching = false;
  }
}

/**
 * Live Whisper progress card driven by the server's SSE channel
 * (GET /api/transcript/progress?jobId=…). Renders a phase label, a real
 * progress bar + %, and an elapsed timer into #output. The card only
 * materialises once the first real progress tick arrives (i.e. Whisper is
 * actually running), so caption-only fetches never flash it. Returns a
 * stop() that closes the stream, stops the timer, and removes the card.
 */
function startWhisperProgress(jobId) {
  let es = null, timerIv = null, started = 0;
  let card = null, fill = null, pctEl = null, phaseEl = null, elapsedEl = null;

  // 'model' fires when the server upgrades the model because the video is not
  // in English — the one moment worth naming, since the run is about to take
  // roughly three times as long and an unexplained wait reads as a hang.
  const phaseLabel = (phase) =>
    phase === 'download'   ? 'Downloading audio…' :
    phase === 'convert'    ? 'Preparing audio…' :
    phase === 'model'      ? 'Switching to the more accurate model…' :
    phase === 'transcribe' ? 'Transcribing with Whisper…' :
    phase === 'done'       ? 'Finishing…' : 'Working…';

  const updateElapsed = () => {
    if (!elapsedEl) return;
    const s = Math.max(0, Math.floor((Date.now() - started) / 1000));
    elapsedEl.textContent =
      String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };

  const ensureCard = () => {
    if (card) return;
    started = Date.now();
    card = document.createElement('div');
    card.className = 'whisper-progress';
    card.innerHTML =
      '<div class="wp-row"><span class="wp-phase"></span><span class="wp-elapsed">00:00</span></div>' +
      '<div class="wp-bar"><div class="wp-fill"></div></div>' +
      '<div class="wp-pct">0%</div>';
    phaseEl   = card.querySelector('.wp-phase');
    elapsedEl = card.querySelector('.wp-elapsed');
    fill      = card.querySelector('.wp-fill');
    pctEl     = card.querySelector('.wp-pct');
    outputEl.innerHTML = '';
    outputEl.appendChild(card);
    outputEl.classList.add('visible');
    timerIv = setInterval(updateElapsed, 1000);
    updateElapsed();
  };

  try {
    es = new EventSource('/api/transcript/progress?jobId=' + encodeURIComponent(jobId));
    es.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.status && d.status !== 'running') return; // terminal — POST drives final UI
      ensureCard();
      const pct = Math.max(0, Math.min(100, Number(d.pct) || 0));
      if (phaseEl) phaseEl.textContent = phaseLabel(d.phase);
      if (fill)    fill.style.width = pct + '%';
      if (pctEl)   pctEl.textContent = pct + '%';
    };
    es.onerror = () => { /* EventSource auto-retries; stop() will close it */ };
  } catch { /* EventSource unsupported — fetch still works, just no live progress */ }

  return function stop() {
    if (es)      { es.close(); es = null; }
    if (timerIv) { clearInterval(timerIv); timerIv = null; }
    if (card && card.parentNode) {
      card.remove();
      if (!outputEl.children.length) outputEl.classList.remove('visible');
    }
  };
}

/** Returns true if `str` looks like a pasteable YouTube reference (URL or bare 11-char id). */
function looksLikeYoutubeRef(str) {
  const s = (str || '').trim();
  if (!s) return false;
  if (/^[\w-]{11}$/.test(s)) return true;
  return /(?:youtube\.com|youtu\.be)\//i.test(s);
}

// Auto-fetch: with the "Get transcript" button removed, entering a valid
// YouTube reference (by paste, typing, Enter, or leaving the field) kicks
// off the fetch — which in turn auto-runs the digest. maybeAutoFetch()
// dedupes so the same URL never re-fires or wastes an AI call.
function maybeAutoFetch() {
  if (isFetching) return;
  const v = urlInput.value.trim();
  if (!looksLikeYoutubeRef(v)) return;
  if (v === lastAutoFetchRef) return;
  fetchTranscript();
}

// Enter → fetch immediately (explicit; bypasses the dedupe/debounce).
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(autoFetchTimer); fetchTranscript(); }
});

// Paste → fetch on the next tick, once the pasted text has landed.
urlInput.addEventListener('paste', () => { setTimeout(maybeAutoFetch, 0); });

// Typing → debounced fetch once the value settles into a valid reference.
urlInput.addEventListener('input', () => {
  clearTimeout(autoFetchTimer);
  autoFetchTimer = setTimeout(maybeAutoFetch, 600);
});

// Leaving the field → fetch immediately if it holds a fresh valid reference.
urlInput.addEventListener('blur', () => { clearTimeout(autoFetchTimer); maybeAutoFetch(); });

radios.forEach(r => r.addEventListener('change', () => {
  syncToggleActive();
  if (lastSegments) {
    renderSegments(lastSegments);
    reApplyOverlays();
  }
  saveSession();
}));

/* ==============================================
   MARKDOWN RENDERER
=============================================== */
/**
 * Minimal inline Markdown renderer.
 * Supports: ## h2, ### h3, - / * bullet lists, **bold**, paragraphs.
 * HTML is escaped before Markdown transforms to prevent injection.
 */
function renderMarkdown(md) {
  // 1. Escape HTML in the raw source first.
  // Delegates to the canonical escapeAttr() (escapes &, <, >, " — same
  // character set this local esc() previously escaped by hand).
  //
  // Control characters are dropped in the same pass, because inlineMarkdown()
  // below parks code spans behind a U+0000 sentinel. Text carrying that byte
  // could otherwise forge a placeholder and get substituted into a <code>
  // element — or, where the index does not exist, render the literal string
  // "undefined". Nothing here can render a control character anyway, so
  // removing them costs nothing and closes the hole at the only door.
  function esc(s) {
    return escapeAttr(String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''));
  }

  // 2. Apply inline transforms (code, links, bold, italic) to an
  //    already-escaped string.
  function inlineMarkdown(s) {
    // Inline code spans first — protect their contents from every other
    // inline transform below by swapping them out for a placeholder.
    const codeSpans = [];
    s = s.replace(/`([^`]+)`/g, (m, code) => {
      codeSpans.push(code);
      return `\u0000CODE${codeSpans.length - 1}\u0000`;
    });

    // Links: [text](url) — only accept safe http(s) URLs, else drop the
    // link and keep the plain text (reuses the same allow-list used
    // everywhere else in the app).
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
      const href = safeHttpUrl(url);
      return href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : text;
    });

    // **bold** or __bold__
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
         .replace(/__(.+?)__/g, '<strong>$1</strong>');

    // *italic* or _italic_ (single markers; bold markers already consumed)
    s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
         .replace(/(^|[^_])_([^_\s][^_]*?)_(?!_)/g, '$1<em>$2</em>');

    // Restore protected code spans
    s = s.replace(/\u0000CODE(\d+)\u0000/g, (m, i) => `<code>${codeSpans[Number(i)]}</code>`);

    return s;
  }

  // 3. Split into lines, process block-level elements.
  const lines = esc(md).split('\n');
  const html  = [];
  let paraBuffer   = [];
  let quoteBuffer  = [];
  let inBlockquote = false;
  let inCodeBlock  = false;
  let codeBuffer   = [];
  const listStack  = []; // [{ indent, type: 'ul'|'ol' }] — supports nested lists

  function flushPara() {
    if (paraBuffer.length === 0) return;
    const content = paraBuffer.join(' ').trim();
    if (content) html.push(`<p>${inlineMarkdown(content)}</p>`);
    paraBuffer = [];
  }

  function flushQuote() {
    if (!inBlockquote) return;
    const content = quoteBuffer.join(' ').trim();
    if (content) html.push(`<blockquote><p>${inlineMarkdown(content)}</p></blockquote>`);
    quoteBuffer  = [];
    inBlockquote = false;
  }

  function closeLists(toIndent = -1) {
    while (listStack.length && listStack[listStack.length - 1].indent > toIndent) {
      const top = listStack.pop();
      html.push(`</${top.type}>`);
    }
  }

  // Opens/closes nested <ul>/<ol> levels as needed for the given indent
  // + list type, then leaves the item's <li> to be pushed by the caller.
  // No explicit </li> is emitted — browsers auto-close the previous <li>
  // when the next <li> (or a nested <ul>/<ol>) starts, which is exactly
  // what lets a deeper-indented list nest inside the prior item.
  function openListLevel(indent, type) {
    while (
      listStack.length &&
      (listStack[listStack.length - 1].indent > indent ||
        (listStack[listStack.length - 1].indent === indent &&
          listStack[listStack.length - 1].type !== type))
    ) {
      const top = listStack.pop();
      html.push(`</${top.type}>`);
    }
    if (!listStack.length || listStack[listStack.length - 1].indent < indent) {
      html.push(`<${type}>`);
      listStack.push({ indent, type });
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Fenced code block toggle (```)
    const fenceMatch = line.trim().match(/^```/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        flushPara(); flushQuote(); closeLists();
        inCodeBlock = true;
        codeBuffer  = [];
      } else {
        html.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
        inCodeBlock = false;
      }
      continue;
    }
    if (inCodeBlock) { codeBuffer.push(rawLine); continue; }

    // Blank line — flush paragraph / blockquote / close lists
    if (!line.trim()) {
      flushPara(); flushQuote(); closeLists();
      continue;
    }

    // Horizontal rule: a line of 3+ -, * or _ (optionally spaced)
    if (/^(-\s*){3,}$|^(\*\s*){3,}$|^(_\s*){3,}$/.test(line.trim())) {
      flushPara(); flushQuote(); closeLists();
      html.push('<hr>');
      continue;
    }

    // Blockquote: "> text" (already HTML-escaped, so ">" is "&gt;")
    const quoteMatch = line.match(/^&gt;\s?(.*)$/);
    if (quoteMatch) {
      flushPara(); closeLists();
      inBlockquote = true;
      quoteBuffer.push(quoteMatch[1]);
      continue;
    } else if (inBlockquote) {
      flushQuote();
    }

    // ### heading (must check before ##)
    if (line.startsWith('### ')) {
      flushPara(); flushQuote(); closeLists();
      html.push(`<h3>${inlineMarkdown(line.slice(4).trim())}</h3>`);
      continue;
    }

    // ## heading
    if (line.startsWith('## ')) {
      flushPara(); flushQuote(); closeLists();
      html.push(`<h2>${inlineMarkdown(line.slice(3).trim())}</h2>`);
      continue;
    }

    // # heading (top-level h1)
    if (line.startsWith('# ')) {
      flushPara(); flushQuote(); closeLists();
      html.push(`<h1>${inlineMarkdown(line.slice(2).trim())}</h1>`);
      continue;
    }

    // Ordered list item: "1. " or "1) " (possibly indented, for nesting)
    const orderedMatch = rawLine.match(/^(\s*)\d+[.)]\s+(.+)$/);
    if (orderedMatch) {
      flushPara(); flushQuote();
      openListLevel(orderedMatch[1].length, 'ol');
      html.push(`<li>${inlineMarkdown(orderedMatch[2])}</li>`);
      continue;
    }

    // Bullet list item: "- " or "* " (possibly indented, for nesting)
    const bulletMatch = rawLine.match(/^(\s*)[-*]\s+(.+)$/);
    if (bulletMatch) {
      flushPara(); flushQuote();
      openListLevel(bulletMatch[1].length, 'ul');
      html.push(`<li>${inlineMarkdown(bulletMatch[2])}</li>`);
      continue;
    }

    // Regular text line — accumulate into paragraph buffer
    // (close any open list first since a non-list line ends the list)
    closeLists();
    paraBuffer.push(line.trim());
  }

  // Flush anything remaining
  if (inCodeBlock && codeBuffer.length) {
    html.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
  }
  flushPara();
  flushQuote();
  closeLists();

  return html.join('\n');
}

function buildPlainTranscript(segments) {
  return segments
    .map(s => s.text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

/** Returns the plain-text transcript string used by all AI calls. */
function getTranscriptText() {
  if (!lastSegments || lastSegments.length === 0) return '';
  return buildPlainTranscript(lastSegments);
}

/* ==============================================
   DIGEST PROGRESS TIMER — live elapsed mm:ss while a digest request is
   in flight, with an honest "large transcript / multiple parts" message
   once estimated transcript size crosses the backend's map-reduce
   threshold (see LONG_PATH_THRESHOLD_CHARS in digest.js, ~480k chars).
   Bypasses setDigestStatus() (which only does textContent) so it can
   render the elapsed-time span alongside the message.
=============================================== */
const DIGEST_LONG_PATH_THRESHOLD_CHARS = 480_000;
let digestTimerHandle = null;
// The AbortController for the digest currently in flight, if any — set at the
// top of runDigest() and cleared in its `finally`. Module-level (not local to
// runDigest) so the Stop button's click handler, which lives outside that
// function, can reach it.
let digestAbortController = null;
let digestTimerStartMs = null;

function formatElapsedMs(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function startDigestTimer(isLargeTranscript) {
  stopDigestTimer();
  digestTimerStartMs = Date.now();
  const baseMsg = isLargeTranscript
    ? 'This is a long transcript — Echo is processing it in multiple parts, which can take a few minutes.'
    : 'Reading the video and writing your digest — usually 10–30s.';
  const tick = () => {
    const elapsed = formatElapsedMs(Date.now() - digestTimerStartMs);
    digestStatus.innerHTML =
      '<span class="digest-progress-msg' + (isLargeTranscript ? ' is-large' : '') + '">' +
        escapeHtml(baseMsg) +
      '</span>' +
      '<span class="digest-progress-elapsed">' + elapsed + '</span>';
    digestStatus.className = 'info';
  };
  tick();
  digestTimerHandle = setInterval(tick, 1000);
}

function stopDigestTimer() {
  if (digestTimerHandle) {
    clearInterval(digestTimerHandle);
    digestTimerHandle = null;
  }
  digestTimerStartMs = null;
}

/* ==============================================
   DIGEST HANDLER (extracted for reuse by both
   digestBtn in Transcript pane and digestRegenBtn
   in Summary panel)
=============================================== */
/**
 * Run a digest over the SSE transport, rendering text as it arrives.
 *
 * Returns the server's final payload (the same object the JSON route returns),
 * or `null` if streaming was not usable — a transport-level failure, a response
 * that was not an event stream, a browser without a readable body. Returning
 * null rather than throwing is deliberate: the caller then falls back to the
 * plain JSON request, so the worst case is the wait users already had.
 *
 * An error *reported by the server mid-stream* is not that case. It comes back
 * as a payload with an `error` key, which the caller renders through the
 * classified error card — retrying it as a JSON request would just spend a
 * second AI call to be told the same thing.
 *
 * Nor is a user-initiated cancel (`signal` aborted) — that must NOT fall back
 * to the buffered retry, since that would exactly undo the cancel. An abort is
 * rethrown rather than swallowed into `null`, and the caller must check for it
 * before treating a null return as "retry unstreamed".
 *
 * @param {object} body
 * @param {AbortSignal} [signal]
 */
async function streamDigest(body, signal) {
  let res;
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    if (ECHO.mode === 'web' || ECHO.mode === 'desktop') {
      const k = getApiKey();
      if (k) headers['X-Echo-Api-Key'] = k;
    }
    res = await fetch('/api/digest?stream=1', { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err; // user cancel — do not retry unstreamed
    return null; // network-level failure: let the caller retry unstreamed
  }

  // A non-stream response means the server answered the old way (or refused).
  // Hand the parsed body back so the caller can render it — including errors,
  // which arrive here as a normal JSON envelope with a non-2xx status.
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  if (!res.body || typeof res.body.getReader !== 'function') return null;

  digestOutput.classList.add('visible');
  let markdown = '';
  let finalPayload = null;

  // Re-rendering Markdown on every token is wasted work at ~20 tokens/second
  // and makes the text jitter. One frame's worth is enough to read as live.
  let paintQueued = false;
  const paint = () => {
    paintQueued = false;
    digestOutput.innerHTML =
      '<div class="digest-eyebrow">AI Digest</div>' + renderMarkdown(markdown);
  };
  const schedulePaint = () => {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(paint);
  };

  const handleEvent = (name, payload) => {
    if (name === 'token' && payload && typeof payload.text === 'string') {
      markdown += payload.text;
      schedulePaint();
      return;
    }
    if (name === 'phase' && payload && payload.phase === 'map') {
      // Long transcripts spend most of their time here, before a word of the
      // digest exists. Say so rather than showing an empty pane.
      setDigestStatus(`Reading the transcript — part ${payload.done} of ${payload.total}…`, false);
      return;
    }
    if (name === 'done') finalPayload = payload;
    if (name === 'error') finalPayload = payload;
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; a frame can straddle reads.
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        let name = 'message';
        const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        try {
          handleEvent(name, JSON.parse(dataLines.join('\n')));
        } catch { /* a frame we cannot parse is not worth failing the stream over */ }
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw err; // user cancel — do not retry unstreamed
    console.error('[echo] digest stream broke mid-flight:', err);
    // Text may already be on screen. If the stream died before `done`, treat
    // it as unusable and let the caller re-run it buffered.
    if (!finalPayload) return null;
  }

  return finalPayload;
}

/**
 * In-app replacement for confirm() when Regenerate is clicked while a digest
 * already exists. Shows the inline #digestReplaceConfirm row (see index.html
 * for why a native modal was dropped in favour of this now that a run is
 * cancellable) and resolves once the user picks Replace/Cancel or presses
 * Escape. Fails open (resolves true) if the row isn't in the DOM, so a markup
 * problem can never silently block digesting.
 * @returns {Promise<boolean>}
 */
function confirmReplaceDigest() {
  return new Promise(resolve => {
    const row = document.getElementById('digestReplaceConfirm');
    const yesBtn = document.getElementById('digestReplaceConfirmYes');
    const noBtn  = document.getElementById('digestReplaceConfirmNo');
    if (!row || !yesBtn || !noBtn) { resolve(true); return; }

    const cleanup = (result) => {
      row.hidden = true;
      yesBtn.removeEventListener('click', onYes);
      noBtn.removeEventListener('click', onNo);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onYes = () => cleanup(true);
    const onNo  = () => cleanup(false);
    const onKey = (e) => { if (e.key === 'Escape') cleanup(false); };

    row.hidden = false;
    yesBtn.addEventListener('click', onYes);
    noBtn.addEventListener('click', onNo);
    document.addEventListener('keydown', onKey);
    noBtn.focus(); // Cancel is the safe default if Enter is pressed
  });
}

async function runDigest() {
  if (!lastSegments || lastSegments.length === 0) return;
  if (!requireApiKey()) return;

  // If a digest is already displayed, confirm before spending another AI call.
  if (currentDigest) {
    const proceed = await confirmReplaceDigest();
    if (!proceed) return;
  }

  // Read options live from the Summary panel controls
  const formatOpt = document.querySelector('input[name="digestFormat"]:checked')?.value || 'digest';
  // `length` only reaches the prompt for `bullets` — digest.js ignores it
  // for `digest` and `article`, which carry their own instructions. Gist is
  // the short end of the dial, so bullets always asks for the short form.
  const lengthOpt = formatOpt === 'bullets' ? 'short' : 'detailed';
  const langOpt   = digestLangInput.value.trim() || 'English';

  digestBtn.disabled      = true;
  digestRegenBtn.disabled = true;
  digestOutput.classList.remove('visible');
  digestOutput.innerHTML   = '';
  usageStatsEl.classList.remove('visible');
  usageStatsEl.innerHTML   = '';

  const plainText = getTranscriptText();
  const isLargeTranscript = plainText.length > DIGEST_LONG_PATH_THRESHOLD_CHARS;

  // Switch to Digest tab and show loading state
  switchTab('digest');
  digestEmptySt.classList.add('is-hidden');
  setTopIndicator('digesting');
  startDigestTimer(isLargeTranscript);

  const body = {
    text: plainText, length: lengthOpt, format: formatOpt, language: langOpt,
    title: (currentMeta && currentMeta.title) || '',
    videoId: (currentMeta && currentMeta.videoId) || undefined,
  };

  // Own AbortController per run, reachable from the Stop button's click
  // handler via the module-level digestAbortController.
  const controller = new AbortController();
  digestAbortController = controller;
  digestStopBtn.hidden = false;

  try {
    const streamed = await streamDigest(body, controller.signal);
    const data = streamed || await (await aiFetch('/api/digest', body, { signal: controller.signal })).json();

    if (data && data.error) {
      stopDigestTimer();
      setTopIndicator('error');
      renderDigestError(data);
      return;
    }

    // Render digest content. When it streamed, the text is already on screen —
    // this final pass replaces the partial render with the authoritative result
    // (the server's `done` payload), which also settles any Markdown that was
    // mid-construction when the last token arrived.
    digestOutput.innerHTML = '<div class="digest-eyebrow">AI Digest</div>' + renderMarkdown(data.digest);
    digestOutput.classList.add('visible');

    // Capture digest text so Save can include it
    currentDigest = data.digest;
    // Auto-tag suggestions were computed server-side in parallel with the
    // digest itself (never shown until Save) — stash for maybeAutoSuggestTags().
    currentSuggestedTags = Array.isArray(data.suggestedTags) ? data.suggestedTags.filter(Boolean) : [];
    syncDigestExportRow();
    syncDigestRegenBtn(); // switch label to "Regenerate"

    // Show ready dot on tab, update status, set indicator
    digestDot.classList.remove('is-hidden');
    stopDigestTimer();
    setDigestStatus('Digest ready.', false);
    setTopIndicator('done');

    // Usage readouts
    if (data.usage) {
      renderUsageStats(data.usage);
    }

    // Stay on Digest tab / Summary sub-panel
    switchTab('digest');
    saveSession();

  } catch (err) {
    if (err && err.name === 'AbortError') {
      // User-initiated cancel (Stop button, tab close, navigation) — not a
      // failure. Must NOT render the error card and must NOT fall back to the
      // buffered retry, either of which would be exactly wrong for something
      // the user asked to stop.
      stopDigestTimer();
      digestOutput.classList.remove('visible');
      digestOutput.innerHTML = '';
      digestEmptySt.classList.remove('is-hidden');
      setDigestStatus('Digest cancelled.', false);
      setTopIndicator('idle');
      return;
    }
    console.error('[echo] runDigest network error:', err);
    stopDigestTimer();
    setDigestStatus('Network error — could not reach the server.', true);
    setTopIndicator('error');
    digestEmptySt.classList.remove('is-hidden');
    showToast('error', 'Network error: ' + err.message);
  } finally {
    stopDigestTimer(); // safety net — idempotent, in case a branch above missed it
    digestBtn.disabled      = false;
    digestRegenBtn.disabled = false;
    digestStopBtn.hidden    = true;
    if (digestAbortController === controller) digestAbortController = null;
  }
}

digestStopBtn.addEventListener('click', () => {
  if (digestAbortController) digestAbortController.abort();
});

digestBtn.addEventListener('click', runDigest);
digestRegenBtn.addEventListener('click', runDigest);

/* ==============================================
   FIDELITY DIAL — Gist / Digest / Everything
   One axis: how much of the video survives. The note under the dial says
   what the selected step does, so the range is self-explanatory rather
   than three bare words.
=============================================== */
const DIGEST_FIDELITY_NOTES = {
  bullets:  'The bottom line and the few points worth knowing. Shortest.',
  digest:   'The real substance, reorganised by idea and told better than the video told it.',
  article:  'Everything that was said, minus the noise of speech. Nothing dropped — read it instead of watching.',
};

function syncFidelityNote() {
  const note = document.getElementById('digestFidelityNote');
  if (!note) return;
  const format = document.querySelector('input[name="digestFormat"]:checked')?.value || 'digest';
  note.textContent = DIGEST_FIDELITY_NOTES[format] || '';
}

const DIGEST_FORMAT_LABELS = { bullets: 'Gist', digest: 'Digest', article: 'Everything' };

/**
 * Keeps the closed #digestOptsDetails disclosure honest: the summary always
 * names the active step once it's not the default, so a closed panel never
 * silently hides a non-default choice (see the comment on #digestOptsDetails
 * in index.html for why this reads better than force-opening the panel).
 */
function syncDigestOptsSummary() {
  const summary = document.getElementById('digestOptsSummary');
  if (!summary) return;
  const format = document.querySelector('input[name="digestFormat"]:checked')?.value || 'digest';
  const isDefault = format === 'digest';
  summary.textContent = isDefault ? 'Options' : `Options — ${DIGEST_FORMAT_LABELS[format] || format}`;
  summary.classList.toggle('has-selection', !isDefault);
}

// Sync active-class + the explanatory note + the disclosure summary for
// digest option segments on change
document.querySelectorAll('input[name="digestFormat"]').forEach(r => {
  r.addEventListener('change', () => { syncToggleActive(); syncFidelityNote(); syncDigestOptsSummary(); });
});
syncFidelityNote();
syncDigestOptsSummary();

/* ==============================================
   SAVE BUTTON HANDLER
=============================================== */
/** Reflect whether the currently-loaded video is already in the library on the Save button. */
function syncSaveButton() {
  if (!saveBtn) return;
  const vid   = currentMeta && currentMeta.videoId;
  const saved = !!vid && savedList.some(e => e.videoId === vid);
  saveBtn.classList.toggle('is-saved', saved);
  if (saveBtnLabel) saveBtnLabel.textContent = saved ? 'Saved' : 'Save';
  saveBtn.setAttribute('aria-label',
    saved ? 'Update this video in your library' : 'Save this video to your library');
}

saveBtn.addEventListener('click', async () => {
  if (!currentMeta || !lastSegments) return;

  saveBtn.disabled = true;
  if (saveBtnLabel) saveBtnLabel.textContent = 'Saving…';

  try {
    const res = await Library.saveEntry({
      url:        currentMeta.url,
      videoId:    currentMeta.videoId,
      title:      currentMeta.title,
      channel:    currentMeta.channel || null,
      channelUrl: currentMeta.channelUrl || null,
      segments:   lastSegments,
      digest:     currentDigest,
      transcriptSource: currentMeta.transcriptSource || 'captions',
      whisperModel:     currentMeta.whisperModel || null,
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      if (saveBtnLabel) saveBtnLabel.textContent = 'Try again';
      saveBtn.disabled = false;
      handleApiError(errData, 'Could not save to library.');
      setTimeout(syncSaveButton, 2500);
      return;
    }

    entryExportBtn.disabled = false;
    saveBtn.classList.add('is-saved');
    if (saveBtnLabel) saveBtnLabel.textContent = 'Saved';
    saveBtn.disabled = false;
    showToast('success', 'Saved to your library.');
    await loadSaved(); // refresh list + count; also re-syncs the button state
    maybeAutoSuggestTags(currentMeta.videoId); // best-effort, fire-and-forget
  } catch (err) {
    console.error('[echo] saveBtn network error:', err);
    if (saveBtnLabel) saveBtnLabel.textContent = 'Network error';
    saveBtn.disabled = false;
    showToast('error', 'Network error: ' + err.message);
    setTimeout(syncSaveButton, 2500);
  }
});

/* ==============================================
   LIBRARY — LOAD & RENDER
=============================================== */
/** Keep the transcript-tab empty state's "open one from your Library" hint in sync with savedList. */
function updateEmptyStateSavedHint() {
  const hintEl = document.getElementById('emptyStateSavedHint');
  if (!hintEl) return;
  const n = savedList.length;
  if (n === 0) {
    hintEl.hidden = true;
    hintEl.innerHTML = '';
    return;
  }
  hintEl.innerHTML = `Or open one from your Library <a href="#" id="emptyStateSavedLink">&rarr;</a>`;
  hintEl.hidden = false;
  document.getElementById('emptyStateSavedLink')?.addEventListener('click', e => {
    e.preventDefault();
    libraryBtnClick();
  });
}

/** Keep the header Library button's count badge in sync with savedList. */
function updateLibraryCount() {
  // savedTotal, not savedList.length: while the rest of a large library is
  // still arriving those differ, and a count that climbs from 120 to 500 as
  // pages land looks like a bug.
  if (libraryCountEl) libraryCountEl.textContent = String(Math.max(savedTotal, savedList.length));
}

// Enough for two render windows, so the first paint is full and the first
// scroll has somewhere to go while the remainder is still in flight.
const SAVED_FIRST_PAGE = 120;
const SAVED_PAGE_SIZE  = 500;

/**
 * Load the library, newest first.
 *
 * The list renders a window at a time, so the first screen needs a page, not
 * the whole library — at 500 entries the full payload is 159 KB and the page
 * cannot show more than about 60 cards of it. So: take a page, paint, then
 * fetch the remainder in the background, because the local filter and the sort
 * both work over the complete list and would quietly go wrong on a partial one.
 *
 * Web mode's adapter reads IndexedDB and ignores the paging arguments — its
 * meta store answers the whole list in about 35 ms, so there is nothing to win.
 */
async function loadSaved() {
  const seq = ++savedLoadSeq;
  try {
    const res = await Library.listEntries({ limit: SAVED_FIRST_PAGE });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      savedOutput.innerHTML =
        '<p class="saved-empty-state">Could not load your library.</p>';
      handleApiError(errData, 'Could not load saved library.');
      return;
    }
    const data = await res.json();
    if (seq !== savedLoadSeq) return; // a newer load has started

    // Bare array = the whole library (web mode, or a server asked for no page).
    if (Array.isArray(data)) {
      savedList  = data;
      savedTotal = data.length;
    } else {
      savedList  = Array.isArray(data.entries) ? data.entries : [];
      savedTotal = Number(data.total) || savedList.length;
    }

    renderSavedFiltered();
    updateEmptyStateSavedHint();
    updateLibraryCount();
    syncSaveButton();

    if (!Array.isArray(data) && data.hasMore) loadRemainingSaved(seq);
  } catch (err) {
    console.error('[echo] loadSaved network error:', err);
    savedOutput.innerHTML =
      '<p class="saved-empty-state">Network error — could not load your library.</p>';
    showToast('error', 'Network error loading library: ' + err.message);
  }
}

/**
 * Fetch everything after the first page, in the background.
 *
 * Failure here is deliberately quiet: the user has a working library of the
 * most recent entries and a toast about page 3 helps nobody. The count still
 * reads the true total, so nothing claims to be complete when it is not.
 */
async function loadRemainingSaved(seq) {
  try {
    while (seq === savedLoadSeq && savedList.length < savedTotal) {
      const res = await Library.listEntries({ limit: SAVED_PAGE_SIZE, offset: savedList.length });
      if (!res.ok) return;
      const data = await res.json();
      const page = Array.isArray(data) ? data : (data.entries || []);
      if (page.length === 0) return;          // nothing further to take; stop rather than spin
      if (seq !== savedLoadSeq) return;

      savedList = savedList.concat(page);
      savedTotal = Array.isArray(data) ? savedList.length : (Number(data.total) || savedTotal);
      if (!Array.isArray(data) && !data.hasMore) break;
    }
    if (seq !== savedLoadSeq) return;
    renderSavedFiltered();
    updateEmptyStateSavedHint();
    updateLibraryCount();
  } catch (err) {
    console.debug('[echo] background library page failed:', err);
  }
}

/** Apply current search filter + sort, then call renderSavedList with the view. */
function renderSavedFiltered() {
  const countEl = document.getElementById('savedResultCount');

  // --- API search mode: results already ranked by the server ---
  if (savedApiResults !== null) {
    const { results } = savedApiResults;
    if (countEl) {
      countEl.innerHTML = results.length === 0
        ? 'No results.'
        : `${results.length} result${results.length === 1 ? '' : 's'}`;
    }
    renderSavedList(results);
    return;
  }

  // --- Local filter + sort mode ---
  let items = savedList.slice();

  // Filter
  if (savedSearchQuery) {
    const q = savedSearchQuery.toLowerCase();
    items = items.filter(e => {
      const title = (e.title || e.videoId || '').toLowerCase();
      const tags  = (Array.isArray(e.tags) ? e.tags : []).join(' ').toLowerCase();
      return title.includes(q) || tags.includes(q);
    });
  }

  // Sort
  if (savedSortMode === 'title') {
    items.sort((a, b) =>
      (a.title || a.videoId || '').localeCompare(b.title || b.videoId || ''));
  } else {
    items.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  }

  // Update result-count line
  if (countEl) {
    if (savedSearchQuery) {
      countEl.textContent = items.length === 0
        ? 'No saved videos match.'
        : `${items.length} result${items.length === 1 ? '' : 's'}`;
    } else {
      countEl.textContent = savedList.length > 0
        ? `${savedList.length} in your library`
        : '';
    }
  }

  renderSavedList(items);
}

/* ----------------------------------------------------------------------------
   Windowed library rendering.

   The list used to build every card in one innerHTML assignment and then wire
   listeners with seven querySelectorAll().forEach() passes. Measured at 500
   entries: 1.15 MB of HTML, 10,851 DOM nodes, 2,043 buttons each carrying its
   own listener — 2,295 ms to open the library and 293 ms per re-render, and a
   re-render happens on every tag edit and every debounced search keystroke.

   Two changes fix it. Cards are rendered a window at a time and extended as the
   sentinel below them scrolls into view, and all the listeners collapse into
   one delegated set on the container — which is also what makes appending more
   cards free, since there is nothing to re-wire.

   The known trade-off: the browser's own Ctrl+F only sees rendered cards. The
   library has its own search field, which covers the whole library (and, in
   local/desktop, the full transcripts), so this costs less than it sounds.
---------------------------------------------------------------------------- */

const SAVED_WINDOW_SIZE = 60;

let savedWindowEntries  = [];    // full filtered list backing the current render
let savedWindowCount    = 0;     // how many of them are actually in the DOM
let savedWindowKey      = '';    // identity of the last render (see below)
let savedWindowObserver = null;
let savedDelegationWired = false;

function renderSavedList(entries) {
  teardownSavedWindow();

  if (!Array.isArray(entries) || entries.length === 0) {
    savedOutput.innerHTML = savedList.length === 0
      ? '<p class="saved-empty-state">Nothing saved yet — load a video and hit <strong>Save</strong>.</p>'
      : '<p class="saved-empty-state">No saved videos match.</p>';
    savedWindowEntries = [];
    savedWindowCount   = 0;
    savedWindowKey     = '';
    return;
  }

  ensureSavedDelegation();

  // Re-rendering the same list — which is what a tag edit does — must not throw
  // someone who has scrolled 300 cards down back to the top with only 60 cards
  // left under them. Comparing the ids exactly rather than guessing from the
  // length: at 500 entries the join costs well under a millisecond, and a
  // heuristic that is wrong once is a scroll position lost for no reason.
  const key      = entries.map(e => e.videoId).join(',');
  const preserve = key === savedWindowKey ? savedWindowCount : 0;
  const scrollY  = window.scrollY;

  savedWindowEntries = entries;
  savedWindowKey     = key;
  savedWindowCount   = 0;
  savedOutput.innerHTML = '';

  appendSavedWindow(Math.max(preserve, SAVED_WINDOW_SIZE));
  if (preserve) window.scrollTo(0, scrollY);
}

/** Render cards up to `target`, appending to whatever is already there. */
function appendSavedWindow(target) {
  const end = Math.min(target, savedWindowEntries.length);
  if (end <= savedWindowCount) return;

  const html = savedWindowEntries.slice(savedWindowCount, end).map(buildSavedCard).join('');
  const sentinel = savedOutput.querySelector('.saved-window-sentinel');
  if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
  else savedOutput.insertAdjacentHTML('beforeend', html);

  savedWindowCount = end;
  updateSavedSentinel();
}

/**
 * Keep the load-more sentinel in step with the window: present and observed
 * while entries remain, gone once everything is rendered.
 */
function updateSavedSentinel() {
  const done = savedWindowCount >= savedWindowEntries.length;
  let sentinel = savedOutput.querySelector('.saved-window-sentinel');

  if (done) {
    if (savedWindowObserver) { savedWindowObserver.disconnect(); savedWindowObserver = null; }
    if (sentinel) sentinel.remove();
    return;
  }

  if (!sentinel) {
    sentinel = document.createElement('div');
    sentinel.className = 'saved-window-sentinel';
    sentinel.setAttribute('aria-hidden', 'true');
    savedOutput.appendChild(sentinel);
  } else {
    savedOutput.appendChild(sentinel); // keep it last after an append
  }

  if (!savedWindowObserver) {
    // rootMargin gives the next window a head start, so scrolling stays smooth
    // instead of stuttering at the boundary. No root: #savedOutput scrolls with
    // the page, and IntersectionObserver accounts for clipping ancestors anyway.
    savedWindowObserver = new IntersectionObserver((records) => {
      if (records.some(r => r.isIntersecting)) {
        appendSavedWindow(savedWindowCount + SAVED_WINDOW_SIZE);
      }
    }, { rootMargin: '600px 0px' });
  }
  savedWindowObserver.observe(sentinel);
}

function teardownSavedWindow() {
  if (savedWindowObserver) { savedWindowObserver.disconnect(); savedWindowObserver = null; }
}

function buildSavedCard(entry) {
  const title   = entry.title || entry.videoId;
  const d       = new Date(entry.savedAt);
  const dateStr = isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' · ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const hasDigest   = entry.digest != null || entry.hasDigest;
  const digestBadge = hasDigest ? '<span class="saved-thumb-badge">Digest</span>' : '';

  // Meta line: saved date + segment count (replaces the noisy repeated URL).
  const segCount = entry.segmentCount || entry.segment_count || 0;
  const segStr   = segCount ? `${segCount.toLocaleString()} segments` : '';
  const metaSep  = (dateStr && segStr)
    ? '<span class="saved-meta-sep" aria-hidden="true">·</span>'
    : '';

  // Tag chips
  const tags     = Array.isArray(entry.tags) ? entry.tags : [];
  const chipsHtml = tags.map(tag =>
    `<span class="saved-tag-chip">` +
      `<button class="saved-tag-filter"
               data-tag="${escapeAttr(tag)}"
               aria-label="Filter by tag: ${escapeAttr(tag)}">${escapeHtml(tag)}</button>` +
      `<button class="saved-tag-remove"
               data-videoid="${escapeAttr(entry.videoId)}"
               data-tag="${escapeAttr(tag)}"
               aria-label="Remove tag ${escapeAttr(tag)}">×</button>` +
    `</span>`
  ).join('');
  const tagAddBtn =
    `<button class="saved-tag-add-btn"
             data-videoid="${escapeAttr(entry.videoId)}"
             aria-label="Add a tag to ${escapeAttr(title)}">＋ tag</button>`;
  const tagsRow =
    `<div class="saved-tags-row" id="tags-row-${escapeAttr(entry.videoId)}">${chipsHtml}${tagAddBtn}</div>`;

  // Export-to-Markdown button
  const exportBtn  =
    `<button class="saved-export-btn"
             data-videoid="${escapeAttr(entry.videoId)}"
             data-title="${escapeAttr(title)}"
             aria-label="Export ${escapeAttr(title)} as Markdown">⬇ .md</button>`;

  // "Send to Obsidian" deep-link button — shown in all modes. Opens the
  // entry as a new note in Obsidian via the obsidian://new URI (digest-only,
  // length-guarded); complements full-vault sync for one-off pushes.
  const obsidianBtn =
    `<button class="saved-obsidian-btn"
             data-videoid="${escapeAttr(entry.videoId)}"
             data-title="${escapeAttr(title)}"
             aria-label="Send ${escapeAttr(title)} to Obsidian">Send to Obsidian</button>`;

  // Thumbnail — only fetched for entries whose URL passed the safe-URL
  // check (unsafe/striped entries get no remote fetch). A failed image load
  // removes itself so the card degrades to the no-thumbnail layout; that is
  // handled by the delegated capturing 'error' listener, not by an onerror
  // attribute, which the CSP refuses.
  const safeUrl  = safeHttpUrl(entry.url);
  const thumbHtml = safeUrl
    ? `<img class="saved-card-thumb"
            src="https://i.ytimg.com/vi/${encodeURIComponent(entry.videoId)}/mqdefault.jpg"
            alt="" loading="lazy">`
    : '';

  return `<div class="saved-card"
               data-videoid="${escapeAttr(entry.videoId)}"
               tabindex="0"
               role="button"
               aria-label="Open ${escapeAttr(title)}">
    <div class="saved-card-thumb-wrap">
      <div class="saved-card-thumb-fallback" aria-hidden="true">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
          <rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/>
          <path d="M10 8.75 15 12l-5 3.25z" fill="currentColor" stroke="none"/>
        </svg>
      </div>
      ${thumbHtml}
      ${digestBadge}
    </div>
    <div class="saved-card-body">
      <div class="saved-card-title-row">
        <div class="saved-card-title">${escapeHtml(title)}</div>
      </div>
      <div class="saved-card-meta">
        ${dateStr ? `<span class="saved-meta-item">${escapeHtml(dateStr)}</span>` : ''}
        ${metaSep}
        ${segStr ? `<span class="saved-meta-item">${escapeHtml(segStr)}</span>` : ''}
      </div>
      ${entry.snippet ? `<p class="saved-snippet">${escapeHtml(entry.snippet)}</p>` : ''}
      ${tagsRow}
      <div class="saved-card-actions">
        ${exportBtn}
        ${obsidianBtn}
        <button class="saved-delete-btn"
                data-videoid="${escapeAttr(entry.videoId)}"
                aria-label="Delete ${escapeAttr(title)}">✕ Delete</button>
      </div>
    </div>
  </div>`;
}

/**
 * One delegated listener set for the whole library, attached once.
 *
 * Previously every card wired its own handlers on every render — at 500 entries
 * that was 2,043 listeners re-attached each time. Delegation makes the cost
 * independent of library size and, more usefully here, means cards appended by
 * the scroll window are live the moment they exist.
 */
function ensureSavedDelegation() {
  if (savedDelegationWired) return;
  savedDelegationWired = true;

  savedOutput.addEventListener('click', (e) => {
    const del = e.target.closest('.saved-delete-btn');
    if (del) { e.stopPropagation(); deleteSavedEntry(del.dataset.videoid); return; }

    const exp = e.target.closest('.saved-export-btn');
    if (exp) { e.stopPropagation(); exportEntryMd(exp.dataset.videoid, exp.dataset.title); return; }

    const obs = e.target.closest('.saved-obsidian-btn');
    if (obs) { e.stopPropagation(); sendEntryToObsidian(obs.dataset.videoid, obs.dataset.title); return; }

    // Click a tag chip's text → filter the library down to that tag.
    const filter = e.target.closest('.saved-tag-filter');
    if (filter) {
      e.stopPropagation();
      const inp = document.getElementById('savedSearchInput');
      if (inp) {
        inp.value        = filter.dataset.tag;
        savedSearchQuery = filter.dataset.tag;
        renderSavedFiltered();
      }
      return;
    }

    const remove = e.target.closest('.saved-tag-remove');
    if (remove) {
      e.stopPropagation();
      patchSavedTags(remove.dataset.videoid,
        (savedList.find(x => x.videoId === remove.dataset.videoid)?.tags || [])
          .filter(t => t !== remove.dataset.tag));
      return;
    }

    const add = e.target.closest('.saved-tag-add-btn');
    if (add) { e.stopPropagation(); showSavedTagInput(add.dataset.videoid, add); return; }

    // Anything left inside a tag chip or the inline tag input is chrome, not a
    // request to open the entry.
    if (e.target.closest('.saved-tag-chip')) return;
    if (e.target.closest('.saved-tag-input')) return;
    if (e.target.closest('.saved-card-url')) return;

    const card = e.target.closest('.saved-card');
    if (card) openSavedEntry(card.dataset.videoid);
  });

  savedOutput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.saved-card');
    if (card && e.target === card) {
      e.preventDefault();
      openSavedEntry(card.dataset.videoid);
    }
  });

  // Thumbnails that 404 fall back to the placeholder behind them. This has to
  // be a capturing listener: `error` does not bubble. It replaces an onerror
  // attribute, which is inline script — the CSP had been refusing it silently,
  // so the fallback never actually ran.
  savedOutput.addEventListener('error', (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.classList.contains('saved-card-thumb')) img.remove();
  }, true);
}

/* ==============================================
   SAVED LIBRARY — TAGS
=============================================== */
async function patchSavedTags(videoId, newTags) {
  const entry = savedList.find(e => e.videoId === videoId);
  if (!entry) return;
  try {
    const res = await Library.setTags(videoId, newTags);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      handleApiError(errData, 'Could not save tags.');
      return;
    }
    entry.tags = newTags;
    renderSavedFiltered();
  } catch (err) {
    console.error('[echo] patchSavedTags network error:', err);
    showToast('warning', 'Could not save tags — network error.');
  }
}

/**
 * Best-effort auto-tag application, fired after a fresh save of a
 * currently-untagged entry (when the "Auto-suggest tags" setting is on).
 * Tags were already computed server-side in parallel with the digest
 * itself (see currentSuggestedTags / POST /api/digest's `suggestedTags`
 * field) — there is no extra network round-trip here, just applying the
 * stashed suggestions via the same patchSavedTags() path the manual tag
 * editor uses, so the resulting chips are normal, editable/removable
 * chips. Any failure is swallowed silently — this must never surface an
 * error or block saving.
 */
async function maybeAutoSuggestTags(videoId) {
  try {
    if (!getAutoTags()) return;

    const entry = savedList.find(e => e.videoId === videoId);
    if (!entry || (entry.tags && entry.tags.length > 0)) return;

    const tags = Array.isArray(currentSuggestedTags) ? currentSuggestedTags.filter(Boolean) : [];
    if (tags.length === 0) return;

    await patchSavedTags(videoId, tags);
    showToast('success', `Added ${tags.length} suggested tag${tags.length === 1 ? '' : 's'}.`);
  } catch (err) {
    console.debug('[echo] auto-tag suggestion skipped:', err);
  }
}

function showSavedTagInput(videoId, addBtn) {
  const container = addBtn.parentElement; // .saved-tags-row
  if (container.querySelector('.saved-tag-input')) {
    container.querySelector('.saved-tag-input').focus();
    return;
  }

  addBtn.style.display = 'none';
  const input          = document.createElement('input');
  input.type           = 'text';
  input.className      = 'saved-tag-input';
  input.placeholder    = 'new tag…';
  input.maxLength      = 30;
  input.setAttribute('aria-label', 'New tag name — press Enter to confirm');

  const commit = () => {
    const val = input.value.trim();
    if (val) {
      const entry = savedList.find(e => e.videoId === videoId);
      const current = entry?.tags || [];
      if (!current.includes(val)) {
        patchSavedTags(videoId, [...current, val]);
      } else {
        // Already exists — just restore UI
        input.remove();
        addBtn.style.display = '';
      }
    } else {
      input.remove();
      addBtn.style.display = '';
    }
  };

  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { input.remove(); addBtn.style.display = ''; }
  });
  input.addEventListener('click',  e => e.stopPropagation());
  input.addEventListener('blur',   () => setTimeout(() => {
    if (document.contains(input)) commit();
  }, 160));

  container.appendChild(input);
  input.focus();
}

/* ==============================================
   JSZIP — vendored, loaded on demand
   Was a blocking <script> from cdn.jsdelivr.net in <head>. Vendoring it drops
   the last external origin from the CSP (script-src is now 'self' alone),
   removes an unpinned third-party script from the page, and makes the ZIP
   export work offline — which matters for an app whose pitch is that it runs
   on your own machine. Injecting a <script src> at runtime is fine under the
   policy: it has a src, so it is not inline.
=============================================== */
let jszipPromise = null;

function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (jszipPromise) return jszipPromise;

  jszipPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/jszip.min.js';
    script.onload = () => resolve(window.JSZip);
    script.onerror = () => {
      // Clear the cached promise so a later attempt can retry rather than
      // inheriting this failure forever.
      jszipPromise = null;
      reject(new Error('Could not load the ZIP library.'));
    };
    document.head.appendChild(script);
  });

  return jszipPromise;
}

/* ==============================================
   SAVED LIBRARY — EXPORT
=============================================== */
async function exportSavedLibrary() {
  const exportBtn = document.getElementById('savedExportBtn');
  const statusMsg = document.getElementById('savedStatusMsg');
  if (!exportBtn || !statusMsg) return;

  exportBtn.disabled      = true;
  exportBtn.textContent   = 'Exporting…';
  statusMsg.textContent   = '';
  statusMsg.className     = 'saved-status-msg';

  try {
    const res = await Library.exportAll();
    if (!res.ok) throw new Error(`Server error (${res.status})`);
    const data    = await res.json();
    const entries = Array.isArray(data.entries) ? data.entries : [];

    // Loaded here rather than on every page load: it is ~95 KB that the
    // overwhelming majority of visits never need.
    const JSZipCtor = await loadJSZip().catch(() => null);

    if (JSZipCtor) {
      const zip = new JSZipCtor();

      for (const entry of entries) {
        const slug = slugify(entry.title || entry.videoId) || entry.videoId;
        const md = entryToMarkdownClient(entry);
        zip.file(`${slug}.md`, md);
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = 'echo-library.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      statusMsg.textContent = `Exported ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} as echo-library.zip.`;

    } else {
      // Graceful fallback: a JSON backup, if the vendored library somehow
      // fails to load (a broken install rather than, as before, a CDN outage).
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = 'echo-library.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      statusMsg.textContent = 'ZIP unavailable (CDN offline) — saved echo-library.json instead.';
    }

  } catch (err) {
    console.error('[echo] exportSavedLibrary error:', err);
    statusMsg.className   = 'saved-status-msg error';
    statusMsg.textContent = 'Export failed: ' + err.message;
    showToast('error', 'Export failed: ' + err.message);
  } finally {
    exportBtn.disabled  = false;
    exportBtn.textContent = 'Export library';
  }
}

/* ==============================================
   SAVED LIBRARY — OPEN ENTRY
=============================================== */
async function openSavedEntry(videoId) {
  try {
    const res = await Library.getEntry(videoId);
    if (res.status === 404) {
      showToast('warning', 'This saved entry was not found — it may have been deleted.');
      loadSaved();
      return;
    }
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      handleApiError(errData, 'Failed to open saved video.');
      return;
    }
    const entry = await res.json();

    // Restore shared state
    lastSegments    = entry.segments;
    currentSegments = entry.segments;
    currentMeta     = {
      videoId: entry.videoId, url: entry.url, title: entry.title,
      channel: entry.channel ?? null, channelUrl: entry.channelUrl ?? null,
      transcriptSource: entry.transcriptSource || 'captions',
      whisperModel: entry.transcriptSource === 'whisper' ? (entry.whisperModel ?? null) : null,
    };
    currentDigest   = entry.digest || null;
    currentSuggestedTags = []; // opening an already-saved entry — nothing to auto-suggest

    // Sync UI — command bar and now-reading strip
    urlInput.value = entry.url;
    updateNowReading();

    // Saved entries don't record which caption track was used, so we
    // can't reliably pre-select the right language option (showing the
    // wrong one — e.g. the alphabetically-first "Abkhazian (auto)" — is
    // worse than showing nothing). Hide the picker until a live fetch
    // repopulates it with real tracks for this video.
    currentLangCode = null;
    if (langPickerWrap) langPickerWrap.hidden = true;
    if (langSelect)     langSelect.innerHTML  = '';
    if (langPickerStatus) {
      langPickerStatus.textContent = '';
      langPickerStatus.className   = 'lang-picker-status';
    }

    // Full digest-pane reset
    digestOutput.classList.remove('visible');
    digestOutput.innerHTML   = '';
    stopDigestTimer();
    digestStatus.textContent = '';
    digestStatus.className   = '';
    digestEmptySt.classList.remove('is-hidden');
    usageStatsEl.classList.remove('visible');
    usageStatsEl.innerHTML   = '';
    digestDot.classList.add('is-hidden');
    setTopIndicator('idle');

    // Restore digest content if it was saved
    if (entry.digest) {
      digestOutput.innerHTML =
        '<div class="digest-eyebrow">AI Digest</div>' +
        renderMarkdown(entry.digest);
      digestOutput.classList.add('visible');
      digestEmptySt.classList.add('is-hidden');
      digestDot.classList.remove('is-hidden');
      setDigestStatus('Digest ready.', false);
    }

    // Render transcript and enable action buttons
    resetFind();
    renderSegments(lastSegments);
    reApplyOverlays();
    digestBtn.disabled              = false;
    saveBtn.disabled                = false;
    syncSaveButton(); // this entry is in the library → shows the "Saved" state
    transcriptCopyBtn.disabled      = false;
    transcriptDownloadBtn.disabled  = false;
    entryExportBtn.disabled         = false;
    syncDigestExportRow();
    syncDigestRegenBtn(); // update label + enable state

    setStatus(`Loaded ${entry.segments.length} segments for video ${entry.videoId}.`);

    // Land on Transcript tab
    switchTab('transcript');
    saveSession();

  } catch (err) {
    console.error('[echo] openSavedEntry network error:', err);
    showToast('error', 'Network error opening saved video: ' + err.message);
  }
}

/* ==============================================
   SAVED LIBRARY — DELETE ENTRY
=============================================== */
async function deleteSavedEntry(videoId) {
  if (!confirm('Delete this saved video? This cannot be undone.')) return;
  try {
    const res = await Library.deleteEntry(videoId);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      handleApiError(errData, 'Failed to delete saved video.');
      return;
    }
    loadSaved();
  } catch (err) {
    console.error('[echo] deleteSavedEntry network error:', err);
    showToast('error', 'Network error: ' + err.message);
  }
}

/* ==============================================
   THEME TOGGLE
=============================================== */
const themeToggleBtn = document.getElementById('themeToggle');

const MOON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const SUN_SVG  = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';

function syncThemeToggle() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  themeToggleBtn.innerHTML = isDark ? SUN_SVG : MOON_SVG;
  themeToggleBtn.setAttribute('aria-label',   isDark ? 'Switch to light theme' : 'Switch to dark theme');
  themeToggleBtn.setAttribute('aria-pressed',  isDark ? 'true' : 'false');
}

themeToggleBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next    = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('echo-theme', next);
  syncThemeToggle();
});

// Follow system preference automatically — unless user has manually toggled
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if (!localStorage.getItem('echo-theme')) {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
      syncThemeToggle();
    }
  });
}

// Sync icon/label to the theme that was already applied by the no-FOUC head script
syncThemeToggle();

/* ==============================================
   SAVED TOOLBAR — EVENT LISTENERS
=============================================== */
(function wireSavedToolbar() {
  const searchInp   = document.getElementById('savedSearchInput');
  const sortSel     = document.getElementById('savedSortSelect');
  const exportBtn   = document.getElementById('savedExportBtn');

  /**
   * Perform a debounced API search.
   * When q is empty, clears savedApiResults and falls back to local filter.
   */
  function triggerSearch(q) {
    // Searches can finish out of order — more easily now that web mode runs a
    // transcript scan whose cost depends on where the match is, so a query for
    // "a" can outlive the "ab" typed after it. Only the newest one may write.
    const seq = ++savedSearchSeq;
    const isCurrent = () => seq === savedSearchSeq;

    if (!q) {
      savedApiResults  = null;
      savedSearchQuery = '';
      renderSavedFiltered();
      return;
    }
    // Web mode has no server-side index, but it does have the transcripts —
    // they are sitting in IndexedDB. This used to stop here at the local
    // title-and-tag filter, so searching in web mode could not see a word of a
    // transcript or a digest, while the same search in local mode went through
    // FTS5 over the lot. IndexedDbLibrary.searchLibrary() closes that gap.
    //
    // It reads transcripts, so it is not instant (~0.5 s over 400 entries).
    // Rather than leave the list stale while it runs, paint the local filter
    // first — it is synchronous and covers titles and tags — and let the
    // full-text results replace it when they land. Same two-stage shape in
    // both modes below; only the adapter differs.
    if (ECHO.mode === 'web') {
      savedApiResults  = null;
      savedSearchQuery = q;
      renderSavedFiltered();
    }

    // Use API for all non-empty queries
    Library.searchLibrary(q)
      .then(r => r.json())
      .then(data => {
        if (!isCurrent()) return;
        if (data.error) {
          // Server error — fall back to client-side filter silently
          savedApiResults  = null;
          savedSearchQuery = q;
        } else {
          savedApiResults  = data; // { results, mode }
          savedSearchQuery = '';   // API handles filtering
        }
        renderSavedFiltered();
      })
      .catch(() => {
        if (!isCurrent()) return;
        // Network failure — fall back to client-side filter
        savedApiResults  = null;
        savedSearchQuery = q;
        renderSavedFiltered();
      });
  }

  if (searchInp) {
    searchInp.addEventListener('input', () => {
      const q = searchInp.value.trim();
      clearTimeout(savedSearchDebTimer);
      savedSearchDebTimer = setTimeout(() => triggerSearch(q), 300);
    });
    // Native × button fires 'search' with empty value
    searchInp.addEventListener('search', () => {
      clearTimeout(savedSearchDebTimer);
      triggerSearch(searchInp.value.trim());
    });
  }

  if (sortSel) {
    sortSel.addEventListener('change', () => {
      savedSortMode = sortSel.value;
      // Sort only applies in local-filter mode; clear API results so sort takes effect
      if (savedApiResults !== null) {
        savedApiResults = null;
        if (searchInp) searchInp.value = '';
        savedSearchQuery = '';
      }
      renderSavedFiltered();
    });
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', exportSavedLibrary);
  }
})();

/* ==============================================
   LOADING SKELETON
=============================================== */
function showTranscriptSkeleton() {
  const widths = [90, 75, 85, 60, 95, 70, 80, 88, 65, 78];

  // Built as nodes rather than an HTML string: a style="" attribute inside
  // innerHTML is parsed markup, so the CSP blocks it once style-src stops
  // allowing inline. Assigning el.style.width is the CSSOM, which it does not
  // govern — the lines still vary in width, they just get there legally.
  const block = document.createElement('div');
  block.className = 'skeleton-block';
  block.setAttribute('aria-hidden', 'true');
  for (const w of widths) {
    const line = document.createElement('div');
    line.className = 'skeleton-line';
    line.style.width = `${w}%`;
    block.appendChild(line);
  }

  outputEl.replaceChildren(block);
  outputEl.classList.add('visible');
}

/* ==============================================
   LANGUAGE PICKER — FEATURE 1
=============================================== */
const langPickerWrap   = document.getElementById('langPickerWrap');
const langSelect       = document.getElementById('langSelect');
const langPickerStatus = document.getElementById('langPickerStatus');

let currentLangCode = null;  // language code currently displayed
let langPickerBusy  = false; // guard against concurrent re-fetches

async function loadLanguageTracks(videoId) {
  if (!langPickerWrap || !langSelect) return;
  langPickerWrap.hidden      = true;
  langSelect.innerHTML       = '';
  if (langPickerStatus) {
    langPickerStatus.textContent = '';
    langPickerStatus.className   = 'lang-picker-status';
  }

  try {
    const res = await fetch(`/api/languages?videoId=${encodeURIComponent(videoId)}`);
    if (!res.ok) return;
    const data   = await res.json();
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    if (tracks.length === 0) return; // keep picker hidden

    // Dedupe by code; split manual vs auto
    const seen   = new Set();
    const manual = [];
    const auto   = [];
    for (const t of tracks) {
      if (seen.has(t.code)) continue;
      seen.add(t.code);
      if (t.auto) auto.push(t); else manual.push(t);
    }
    const deduped = manual.concat(auto);

    // If the server couldn't tell us which track was actually loaded
    // (currentLangCode is null — e.g. a fetch quirk), fall back rather
    // than letting the <select> default to whichever option sorts first
    // alphabetically:
    //   - exactly one track available → that must be the loaded one
    //   - more than one → we can't honestly know which, so hide the
    //     picker instead of showing a misleading selection
    if (!currentLangCode) {
      if (deduped.length === 1) {
        currentLangCode = deduped[0].code;
      } else {
        return; // keep picker hidden — see langPickerWrap.hidden = true above
      }
    }

    const makeOpt = t => {
      const sel = t.code === currentLangCode ? ' selected' : '';
      const lbl = t.auto ? `${escapeHtml(t.name)} (auto)` : escapeHtml(t.name);
      return `<option value="${escapeAttr(t.code)}"${sel}>${lbl}</option>`;
    };

    let html = '';
    if (manual.length > 0) {
      html += `<optgroup label="Original / manual">${manual.map(makeOpt).join('')}</optgroup>`;
    }
    if (auto.length > 0) {
      html += `<optgroup label="Auto-translated">${auto.map(makeOpt).join('')}</optgroup>`;
    }

    langSelect.innerHTML  = html;
    langPickerWrap.hidden = false;
  } catch (_) {
    /* Silently ignore — picker stays hidden */
  }
}

langSelect && langSelect.addEventListener('change', async () => {
  if (langPickerBusy || !currentMeta) return;
  const code    = langSelect.value;
  const prevCode = currentLangCode;
  if (!code) return;

  langPickerBusy  = true;
  currentLangCode = code;
  if (langPickerStatus) {
    langPickerStatus.textContent = 'Loading…';
    langPickerStatus.className   = 'lang-picker-status';
  }

  // Show skeleton while re-fetching
  showTranscriptSkeleton();

  try {
    const res  = await fetch('/api/transcript', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url: currentMeta.url, lang: code }),
    });
    const data = await res.json();

    if (!res.ok) {
      // Revert to previous selection
      currentLangCode = prevCode;
      if (langSelect && prevCode) langSelect.value = prevCode;
      if (langPickerStatus) {
        langPickerStatus.textContent = apiErrorMessage(data, 'Failed to load this language.');
        langPickerStatus.className   = 'lang-picker-status error';
      }
      handleApiError(data, 'Failed to load transcript in this language.');
      // Restore previous transcript display
      if (lastSegments) { renderSegments(lastSegments); reApplyOverlays(); }
      else { outputEl.classList.remove('visible'); outputEl.innerHTML = ''; }
      return;
    }

    lastSegments    = data.segments;
    currentSegments = data.segments;
    if (langPickerStatus) {
      langPickerStatus.textContent = '';
      langPickerStatus.className   = 'lang-picker-status';
    }
    resetFind();
    renderSegments(lastSegments);
    reApplyOverlays();
    setStatus(`Loaded ${data.segments.length} segments (${code}).`);

  } catch (err) {
    console.error('[echo] langSelect network error:', err);
    currentLangCode = prevCode;
    if (langSelect && prevCode) langSelect.value = prevCode;
    if (langPickerStatus) {
      langPickerStatus.textContent = 'Network error — could not load this language.';
      langPickerStatus.className   = 'lang-picker-status error';
    }
    showToast('error', 'Network error loading language: ' + err.message);
    if (lastSegments) { renderSegments(lastSegments); reApplyOverlays(); }
    else { outputEl.classList.remove('visible'); outputEl.innerHTML = ''; }
  } finally {
    langPickerBusy = false;
  }
});

/* ==============================================
   KEYBOARD SHORTCUTS OVERLAY — FEATURE 4
=============================================== */
const shortcutsOverlayEl = document.getElementById('shortcutsOverlay');

function openShortcutsOverlay() {
  if (!shortcutsOverlayEl) return;
  shortcutsOverlayEl.hidden = false;
  document.getElementById('shortcutsClose')?.focus();
}

function closeShortcutsOverlay() {
  if (!shortcutsOverlayEl) return;
  shortcutsOverlayEl.hidden = true;
}

document.getElementById('shortcutsBtn')?.addEventListener('click', openShortcutsOverlay);
document.getElementById('shortcutsClose')?.addEventListener('click', closeShortcutsOverlay);
document.getElementById('shortcutsBackdrop')?.addEventListener('click', closeShortcutsOverlay);

/* ==============================================
   WEB MODE — BYOK SETTINGS MODAL
   Only relevant when ECHO.mode === 'web'. Stores the
   user's Anthropic API key in localStorage and sends
   it via the X-Echo-Api-Key header on AI requests.
=============================================== */
const API_KEY_STORAGE_KEY = 'echo-anthropic-key';

function getApiKey() {
  try { return localStorage.getItem(API_KEY_STORAGE_KEY) || ''; }
  catch { return ''; }
}

function setApiKey(v) {
  try { localStorage.setItem(API_KEY_STORAGE_KEY, (v || '').trim()); }
  catch { /* localStorage unavailable — non-fatal */ }
}

function clearApiKey() {
  try { localStorage.removeItem(API_KEY_STORAGE_KEY); }
  catch { /* localStorage unavailable — non-fatal */ }
}

// Auto-digest preference (default ON — AI digest is Echo's core product).
const AUTO_DIGEST_STORAGE_KEY = 'echo-auto-digest';

function getAutoDigest() {
  try { return localStorage.getItem(AUTO_DIGEST_STORAGE_KEY) !== 'false'; }
  catch { return true; }
}

function setAutoDigest(on) {
  try { localStorage.setItem(AUTO_DIGEST_STORAGE_KEY, on ? 'true' : 'false'); }
  catch { /* localStorage unavailable — non-fatal */ }
}

// Auto-tag preference (default ON for local/desktop, OFF for web — web
// requires a BYOK key and we don't want to surprise-spend it silently).
const AUTO_TAGS_STORAGE_KEY = 'echo-auto-tags';

function getAutoTags() {
  try {
    const raw = localStorage.getItem(AUTO_TAGS_STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return ECHO.mode !== 'web';
  } catch { return ECHO.mode !== 'web'; }
}

function setAutoTags(on) {
  try { localStorage.setItem(AUTO_TAGS_STORAGE_KEY, on ? 'true' : 'false'); }
  catch { /* localStorage unavailable — non-fatal */ }
}

// Whisper transcription preferences (P2) — local/desktop only. Mode:
// off (captions only, default) / fallback (Whisper when captions are
// missing) / always (Whisper regardless of captions). Model: the
// whisper.cpp ggml model tier to use when Whisper runs.
const WHISPER_MODE_STORAGE_KEY  = 'echo-whisper-mode';
const WHISPER_MODEL_STORAGE_KEY = 'echo-whisper-model';
const WHISPER_MODES  = ['off', 'fallback', 'always'];
const WHISPER_MODELS_CLIENT = ['base', 'small'];

function getWhisperMode() {
  try {
    const raw = localStorage.getItem(WHISPER_MODE_STORAGE_KEY);
    return WHISPER_MODES.includes(raw) ? raw : 'off';
  } catch { return 'off'; }
}

function setWhisperMode(mode) {
  try { localStorage.setItem(WHISPER_MODE_STORAGE_KEY, WHISPER_MODES.includes(mode) ? mode : 'off'); }
  catch { /* localStorage unavailable — non-fatal */ }
}

function getWhisperModel() {
  try {
    const raw = localStorage.getItem(WHISPER_MODEL_STORAGE_KEY);
    return WHISPER_MODELS_CLIENT.includes(raw) ? raw : 'base';
  } catch { return 'base'; }
}

function setWhisperModel(model) {
  try { localStorage.setItem(WHISPER_MODEL_STORAGE_KEY, WHISPER_MODELS_CLIENT.includes(model) ? model : 'base'); }
  catch { /* localStorage unavailable — non-fatal */ }
}

const settingsOverlayEl  = document.getElementById('settingsOverlay');
const apiKeyInputEl      = document.getElementById('apiKeyInput');
const apiKeyStatusEl     = document.getElementById('apiKeyStatus');
const settingsSaveKeyBtnEl = document.getElementById('settingsSaveKeyBtn');
const autoDigestToggleEl = document.getElementById('autoDigestToggle');
const autoTagToggleEl    = document.getElementById('autoTagToggle');

const whisperSettingsEl       = document.getElementById('whisperSettings');
const whisperBinaryNoteEl     = document.getElementById('whisperBinaryNote');
const whisperModeSelectEl     = document.getElementById('whisperModeSelect');
const whisperModelSelectEl    = document.getElementById('whisperModelSelect');
const whisperModelStateTextEl = document.getElementById('whisperModelStateText');
const whisperDownloadBtnEl    = document.getElementById('whisperDownloadBtn');
const whisperProgressEl       = document.getElementById('whisperProgress');
const whisperProgressFillEl   = document.getElementById('whisperProgressFill');
const whisperProgressTextEl   = document.getElementById('whisperProgressText');

// Vault sync preferences — folder path + last-sync result, local/desktop only.
const VAULT_DIR_STORAGE_KEY       = 'echo-vault-dir';
const VAULT_LAST_SYNC_STORAGE_KEY = 'echo-vault-last-sync';

function getVaultDir() {
  try { return localStorage.getItem(VAULT_DIR_STORAGE_KEY) || ''; }
  catch { return ''; }
}

function setVaultDir(v) {
  try { localStorage.setItem(VAULT_DIR_STORAGE_KEY, v || ''); }
  catch { /* localStorage unavailable — non-fatal */ }
}

function getVaultLastSync() {
  try {
    const raw = localStorage.getItem(VAULT_LAST_SYNC_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function setVaultLastSync(info) {
  try { localStorage.setItem(VAULT_LAST_SYNC_STORAGE_KEY, JSON.stringify(info)); }
  catch { /* localStorage unavailable — non-fatal */ }
}

const vaultDirInputEl    = document.getElementById('vaultDirInput');
const vaultSyncBtnEl     = document.getElementById('vaultSyncBtn');
const vaultSyncStatusEl  = document.getElementById('vaultSyncStatus');
const vaultSyncLocalEl   = document.getElementById('vaultSyncLocal');
const vaultSyncWebEl     = document.getElementById('vaultSyncWeb');
const vaultZipBtnEl      = document.getElementById('vaultZipBtn');
const vaultFolderSyncBtnEl  = document.getElementById('vaultFolderSyncBtn');
const vaultWebSyncStatusEl  = document.getElementById('vaultWebSyncStatus');
const vaultFolderSyncEl     = document.getElementById('vaultFolderSync');
const obsidianVaultNameInputEl = document.getElementById('obsidianVaultNameInput');

/* ==============================================
   VAULT FOLDER SYNC (web mode) — File System Access API
   Chromium-only client-side folder sync, the web-mode
   equivalent of the local /api/vault/sync route. Entirely
   in-browser: no server route, no server filesystem.
=============================================== */
/** Writes a status message into the web-mode vault sync status line. */
function setVaultWebStatus(msg) {
  if (vaultWebSyncStatusEl) vaultWebSyncStatusEl.textContent = msg || '';
}

// Dedicated tiny IndexedDB (separate from the main ECHO_DB) that holds
// just the one persisted FileSystemDirectoryHandle the user picked, so
// repeat syncs don't need to re-prompt the folder picker every time.
const VAULT_FS_DB_NAME = 'echo-vault-fs';
const VAULT_FS_DB_VERSION = 1;
let _vaultFsDbPromise = null;

function vaultFsDbOpen() {
  if (_vaultFsDbPromise) return _vaultFsDbPromise;
  _vaultFsDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(VAULT_FS_DB_NAME, VAULT_FS_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('handles')) {
        db.createObjectStore('handles');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _vaultFsDbPromise;
}

async function vaultFsGetHandle() {
  try {
    const db = await vaultFsDbOpen();
    return await new Promise((resolve, reject) => {
      const tx  = db.transaction('handles', 'readonly');
      const req = tx.objectStore('handles').get('dir');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  } catch { return null; }
}

async function vaultFsPutHandle(handle) {
  try {
    const db = await vaultFsDbOpen();
    return await new Promise((resolve, reject) => {
      const tx  = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(handle, 'dir');
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch { /* non-fatal — worst case we just re-prompt next time */ }
}

/** Verifies (and if needed, re-requests) readwrite permission on a persisted directory handle. */
async function ensureVaultPermission(handle) {
  try {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch { return false; }
}

/**
 * Entry point for the "Sync to vault folder…" button. Reuses a
 * previously-persisted folder handle if permission is still granted;
 * otherwise prompts the native folder picker (also how a user "creates"
 * a new vault — pointing it at a fresh empty folder works fine).
 */
async function pickAndSyncVaultFolder() {
  try {
    const existing = await vaultFsGetHandle();
    if (existing && await ensureVaultPermission(existing)) {
      await runVaultFolderSync(existing);
      return;
    }

    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'echo-vault' });
    await vaultFsPutHandle(handle);
    await runVaultFolderSync(handle);
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user cancelled the picker
    console.error('[echo] vault folder sync error:', err);
    setVaultWebStatus('Could not open that folder.');
  }
}

/** Writes every saved entry as a Markdown file into the given directory handle. */
/**
 * Client-side mirror of vault.js's monthFolder() — groups notes into a
 * YYYY-MM subfolder by save date so the vault file tree stays browsable.
 */
function monthFolderClient(savedAt) {
  const d = savedAt ? new Date(savedAt) : null;
  if (!d || isNaN(d.getTime())) return 'Undated';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function runVaultFolderSync(handle) {
  const granted = await ensureVaultPermission(handle);
  if (!granted) {
    setVaultWebStatus('Permission to write to that folder was denied.');
    return;
  }

  setVaultWebStatus('Syncing…');
  if (vaultFolderSyncBtnEl) vaultFolderSyncBtnEl.disabled = true;

  let written = 0, unchanged = 0, failed = 0;
  let entries = [];
  try {
    const res  = await Library.exportAll();
    const data = await res.json();
    entries    = Array.isArray(data.entries) ? data.entries : [];

    const indexItems = [];
    for (const entry of entries) {
      try {
        const slug = slugify(entry.title || entry.videoId) || entry.videoId;
        const name = `${slug}-${entry.videoId}.md`;
        const md   = entryToMarkdownClient(entry);

        indexItems.push({
          link: `${slug}-${entry.videoId}`,
          title: entry.title || entry.videoId,
          savedAt: entry.savedAt || '',
          tags: Array.isArray(entry.tags) ? entry.tags.filter(Boolean) : [],
          summary: extractSummaryClient(entry.digest),
        });

        const sub = monthFolderClient(entry.savedAt);
        const dirHandle = await handle.getDirectoryHandle(sub, { create: true });
        const fh = await dirHandle.getFileHandle(name, { create: true });
        let existingText = null;
        try { existingText = await (await fh.getFile()).text(); } catch { existingText = null; }

        if (existingText === md) {
          unchanged++;
          continue;
        }

        const writable = await fh.createWritable();
        await writable.write(md);
        await writable.close();
        written++;
      } catch (entryErr) {
        console.error('[echo] vault folder sync entry error:', entryErr);
        failed++;
      }
    }

    if (indexItems.length > 0) {
      try {
        const indexMd = buildVaultIndexClient(indexItems);
        const idxFh = await handle.getFileHandle('Echo Library.md', { create: true });
        let existingIdx = null;
        try { existingIdx = await (await idxFh.getFile()).text(); } catch { existingIdx = null; }
        if (existingIdx !== indexMd) {
          const w = await idxFh.createWritable();
          await w.write(indexMd);
          await w.close();
        }
      } catch (idxErr) {
        console.error('[echo] vault index note error:', idxErr);
      }
    }

    let msg;
    if (entries.length === 0) {
      msg = 'No saved entries to sync yet.';
    } else if (written === 0 && failed === 0) {
      msg = `Vault already up to date — ${unchanged} file${unchanged === 1 ? '' : 's'} in "${handle.name}", nothing changed.`;
    } else {
      const parts = [];
      if (written)   parts.push(`${written} written`);
      if (unchanged) parts.push(`${unchanged} unchanged`);
      if (failed)    parts.push(`${failed} failed`);
      msg = `Synced ${entries.length} to "${handle.name}": ${parts.join(', ')}.`;
    }
    setVaultWebStatus(msg);
    setVaultLastSync({ when: new Date().toISOString(), total: entries.length, written, unchanged, failed });
  } catch (err) {
    console.error('[echo] vault folder sync error:', err);
    setVaultWebStatus('Vault sync failed: ' + (err && err.message || err));
  } finally {
    if (vaultFolderSyncBtnEl) vaultFolderSyncBtnEl.disabled = false;
  }
}

// Optional Obsidian vault name — used by the per-note "Send to Obsidian"
// deep-link button so it can target a specific vault instead of
// whichever one is currently open in the Obsidian app.
const OBSIDIAN_VAULT_NAME_STORAGE_KEY = 'echo-obsidian-vault';

function getObsidianVaultName() {
  try { return localStorage.getItem(OBSIDIAN_VAULT_NAME_STORAGE_KEY) || ''; }
  catch { return ''; }
}

function setObsidianVaultName(v) {
  try { localStorage.setItem(OBSIDIAN_VAULT_NAME_STORAGE_KEY, v || ''); }
  catch { /* localStorage unavailable — non-fatal */ }
}

/**
 * Sends a single saved entry to Obsidian via the obsidian://new URI
 * scheme (works cross-browser, no filesystem API required). Builds a
 * digest-only Markdown body (transcript omitted — URIs have a practical
 * length ceiling) and opens it as a new note in the user's vault.
 */
async function sendEntryToObsidian(videoId, title) {
  try {
    const res = await Library.entryMarkdown(videoId, { includeTranscript: false });
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      if (d) return handleApiError(d);
      return showToast('error', 'Could not open that entry for Obsidian.');
    }
    const md   = await res.text();
    const slug = slugify(title || videoId) || videoId;
    const vaultName = getObsidianVaultName();

    const uri = 'obsidian://new?' +
      (vaultName ? `vault=${encodeURIComponent(vaultName)}&` : '') +
      `file=${encodeURIComponent(slug)}&content=${encodeURIComponent(md)}&silent=true`;

    if (uri.length > 8000) {
      showToast('error', 'This digest is too long to send via link.',
        'Use "Sync to vault folder" or the ZIP export instead.');
      return;
    }

    window.location.href = uri;
  } catch (e) {
    showToast('error', 'Could not send to Obsidian', String(e && e.message || e));
  }
}

/** Renders the last-synced indicator from a stored {when, written, total, unchanged} record. */
function renderVaultSyncStatus() {
  if (!vaultSyncStatusEl) return;
  const info = getVaultLastSync();
  if (!info) {
    vaultSyncStatusEl.textContent = '';
    return;
  }
  const when = new Date(info.when);
  const whenStr = isNaN(when.getTime()) ? '' : when.toLocaleString();
  vaultSyncStatusEl.textContent =
    `Last synced ${whenStr}: ${info.written} written, ${info.unchanged} unchanged` +
    (info.failed ? `, ${info.failed} failed` : '') + '.';
}

/** Handles the "Sync to vault" button — POSTs to /api/vault/sync (local/desktop only). */
async function syncVault() {
  if (!vaultDirInputEl || !vaultSyncBtnEl) return;
  const dir = vaultDirInputEl.value.trim();
  if (!dir) {
    if (vaultSyncStatusEl) vaultSyncStatusEl.textContent = 'Enter a folder path first.';
    return;
  }

  setVaultDir(dir);
  vaultSyncBtnEl.disabled = true;
  if (vaultSyncStatusEl) vaultSyncStatusEl.textContent = 'Syncing…';

  try {
    const res  = await fetch('/api/vault/sync', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ dir }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = data?.error?.message || data?.message || 'Vault sync failed.';
      if (vaultSyncStatusEl) vaultSyncStatusEl.textContent = msg;
      showToast('error', msg);
      return;
    }

    const { total = 0, written = 0, unchanged = 0, failed = 0 } = data;
    setVaultLastSync({ when: new Date().toISOString(), total, written, unchanged, failed });
    renderVaultSyncStatus();
    showToast('success', `Synced ${written} files to ${dir} (${unchanged} unchanged).`);
  } catch (err) {
    console.error('[echo] vault sync network error:', err);
    const msg = 'Network error while syncing the vault.';
    if (vaultSyncStatusEl) vaultSyncStatusEl.textContent = msg;
    showToast('error', msg);
  } finally {
    vaultSyncBtnEl.disabled = false;
  }
}

vaultSyncBtnEl?.addEventListener('click', syncVault);
vaultZipBtnEl?.addEventListener('click', exportSavedLibrary);
vaultFolderSyncBtnEl?.addEventListener('click', pickAndSyncVaultFolder);
obsidianVaultNameInputEl?.addEventListener('change', () => {
  setObsidianVaultName(obsidianVaultNameInputEl.value.trim());
});

// Folder-picker sync (File System Access API) is Chromium-only but works in
// EVERY mode — it reads the active Library (server in local/desktop,
// IndexedDB in web) and writes client-side via the picked directory handle.
// Show it wherever the API exists; the typed-path (local) and ZIP (web)
// blocks below remain as the non-Chromium fallbacks.
if (vaultFolderSyncEl) vaultFolderSyncEl.hidden = !('showDirectoryPicker' in window);

if (ECHO.mode === 'web') {
  if (vaultSyncLocalEl) vaultSyncLocalEl.hidden = true;
  if (vaultSyncWebEl) vaultSyncWebEl.hidden = false;
  if (obsidianVaultNameInputEl) obsidianVaultNameInputEl.value = getObsidianVaultName();
} else {
  if (vaultSyncLocalEl) vaultSyncLocalEl.hidden = false;
  if (vaultSyncWebEl) vaultSyncWebEl.hidden = true;
}

/* ==============================================
   WHISPER TRANSCRIPTION SETTINGS (P2) — local/desktop only.
   Backend routes (/api/whisper/status, /api/whisper/model) are gated
   blockInWeb, so this whole subsystem stays inert (and hidden) in web
   mode. Model bytes: whisper.cpp ggml q5_1 tier, sizes come straight
   from the /api/whisper/status response — never hardcoded here beyond
   the option labels, which are display copy only.
=============================================== */
let _whisperStatusCache   = null;
let _whisperPollTimer     = null;
let _whisperPollActive    = false;

/** Renders the last-fetched /api/whisper/status payload into the settings UI. */
function renderWhisperStatus(data) {
  if (!data) return;
  const binaryPresent = !!data.binaryPresent;
  const mode          = getWhisperMode();
  const modelName     = getWhisperModel();
  const model = Array.isArray(data.models) ? data.models.find(m => m.name === modelName) : null;

  if (whisperModeSelectEl)  whisperModeSelectEl.disabled  = !binaryPresent;
  if (whisperDownloadBtnEl) whisperDownloadBtnEl.disabled = !binaryPresent || _whisperPollActive;

  if (whisperBinaryNoteEl) {
    if (!binaryPresent) {
      whisperBinaryNoteEl.textContent = 'whisper-cli not found — set the ECHO_WHISPER environment variable to enable.';
      whisperBinaryNoteEl.className   = 'settings-key-status error';
    } else if (mode !== 'off' && model && !model.present) {
      // Gentle hint: the user asked for Whisper but hasn't downloaded the model yet.
      whisperBinaryNoteEl.textContent = 'Download the selected model below to use Whisper transcription.';
      whisperBinaryNoteEl.className   = 'settings-key-status';
    } else {
      whisperBinaryNoteEl.textContent = '';
      whisperBinaryNoteEl.className   = 'settings-key-status';
    }
  }

  if (whisperModelStateTextEl) {
    if (model && model.present) {
      whisperModelStateTextEl.textContent = 'Downloaded';
    } else if (model) {
      const mb = Math.round((model.sizeBytes || 0) / 1048576);
      whisperModelStateTextEl.textContent = `Not downloaded — ${mb} MB`;
    } else {
      whisperModelStateTextEl.textContent = '';
    }
  }
  if (whisperDownloadBtnEl) {
    whisperDownloadBtnEl.hidden = !!(model && model.present);
  }
}

/** GET /api/whisper/status and reflect it into the settings UI. Local/desktop only. */
async function refreshWhisperStatus() {
  if (ECHO.mode === 'web') return;
  try {
    const res = await fetch('/api/whisper/status');
    if (!res.ok) return;
    const data = await res.json();
    _whisperStatusCache = data;
    renderWhisperStatus(data);
  } catch (err) {
    console.error('[echo] whisper status fetch error:', err);
  }
}

function stopWhisperPoll() {
  _whisperPollActive = false;
  if (_whisperPollTimer) { clearInterval(_whisperPollTimer); _whisperPollTimer = null; }
}

/** Polls /api/whisper/status ~every second while a model download is in flight. */
function pollWhisperDownload(model) {
  if (_whisperPollActive) return; // guard against overlapping pollers
  _whisperPollActive = true;
  if (whisperProgressEl)     whisperProgressEl.hidden = false;
  if (whisperDownloadBtnEl)  whisperDownloadBtnEl.disabled = true;
  if (whisperProgressTextEl) whisperProgressTextEl.textContent = 'Downloading… 0%';
  if (whisperProgressFillEl) whisperProgressFillEl.style.width = '0%';

  _whisperPollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/whisper/status');
      if (!res.ok) return;
      const data = await res.json();
      _whisperStatusCache = data;
      const m = Array.isArray(data.models) ? data.models.find(x => x.name === model) : null;
      if (!m) return;

      if (m.present) {
        stopWhisperPoll();
        if (whisperProgressEl) whisperProgressEl.hidden = true;
        if (whisperProgressTextEl) whisperProgressTextEl.textContent = '';
        renderWhisperStatus(data);
        return;
      }
      if (m.state === 'error') {
        stopWhisperPoll();
        if (whisperProgressTextEl) whisperProgressTextEl.textContent = m.error || 'Download failed.';
        renderWhisperStatus(data);
        return;
      }
      const pct = typeof m.percent === 'number' ? m.percent : 0;
      if (whisperProgressFillEl) whisperProgressFillEl.style.width = pct + '%';
      if (whisperProgressTextEl) whisperProgressTextEl.textContent = `Downloading… ${pct}%`;
    } catch (err) {
      console.error('[echo] whisper status poll error:', err);
    }
  }, 1000);
}

/** POST /api/whisper/model to (idempotently) start a download, then poll for progress. */
async function startWhisperDownload(model) {
  if (_whisperPollActive) return; // guard against overlapping pollers
  try {
    await fetch('/api/whisper/model', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model }),
    });
  } catch (err) {
    console.error('[echo] whisper model download start error:', err);
  }
  pollWhisperDownload(model);
}

whisperModeSelectEl?.addEventListener('change', () => {
  setWhisperMode(whisperModeSelectEl.value);
  renderWhisperStatus(_whisperStatusCache);
});

whisperModelSelectEl?.addEventListener('change', () => {
  setWhisperModel(whisperModelSelectEl.value);
  renderWhisperStatus(_whisperStatusCache);
});

whisperDownloadBtnEl?.addEventListener('click', () => {
  startWhisperDownload(getWhisperModel());
});

// Whisper is local/desktop only — the settings block itself stays hidden
// (and its select/status untouched) in web mode.
if (ECHO.mode !== 'web') {
  if (whisperSettingsEl) whisperSettingsEl.hidden = false;
  if (whisperModeSelectEl)  whisperModeSelectEl.value  = getWhisperMode();
  if (whisperModelSelectEl) whisperModelSelectEl.value = getWhisperModel();
  refreshWhisperStatus();
}

/** Sets the inline key-status line under the API key input (Task 3). */
function setKeyStatus(text, level) {
  if (!apiKeyStatusEl) return;
  apiKeyStatusEl.textContent = text || '';
  apiKeyStatusEl.className   = 'settings-key-status' + (level ? ' ' + level : '');
}

function openSettingsModal() {
  if (!settingsOverlayEl) return;
  if (apiKeyInputEl) apiKeyInputEl.value = getApiKey();
  setKeyStatus('', '');
  if (autoDigestToggleEl) autoDigestToggleEl.checked = getAutoDigest();
  if (autoTagToggleEl) autoTagToggleEl.checked = getAutoTags();
  if (vaultDirInputEl) vaultDirInputEl.value = getVaultDir();
  if (obsidianVaultNameInputEl) obsidianVaultNameInputEl.value = getObsidianVaultName();
  renderVaultSyncStatus();
  if (ECHO.mode !== 'web') {
    if (whisperSettingsEl) whisperSettingsEl.hidden = false;
    if (whisperModeSelectEl)  whisperModeSelectEl.value  = getWhisperMode();
    if (whisperModelSelectEl) whisperModelSelectEl.value = getWhisperModel();
    refreshWhisperStatus();
  }
  settingsOverlayEl.hidden = false;
  // Focus the key field in web mode; otherwise the (visible) auto-digest toggle.
  if (ECHO.mode === 'web') apiKeyInputEl?.focus();
  else autoDigestToggleEl?.focus();
}

function closeSettingsModal() {
  if (!settingsOverlayEl) return;
  settingsOverlayEl.hidden = true;
}

document.getElementById('settingsBtn')?.addEventListener('click', openSettingsModal);
document.getElementById('settingsClose')?.addEventListener('click', closeSettingsModal);
document.getElementById('settingsBackdrop')?.addEventListener('click', closeSettingsModal);

/**
 * Save button behavior:
 *  - Local mode: unchanged — store the key as-is, no validation call
 *    (the key section isn't even shown in local mode).
 *  - Web mode with a non-empty key: validate against POST /api/validate-key
 *    (X-Echo-Api-Key header) before storing. Valid → store + toast + close.
 *    Invalid/network error → do NOT store, show inline error, keep modal open.
 *  - Web mode with an empty field: treat Save as a clear (no validation needed).
 */
/* ==============================================
   ACCOUNT — Google sign-in for library sync (web mode)
   Only appears when the server has accounts configured; a deployment
   without them shows nothing and behaves exactly as before.
=============================================== */
async function renderAccountState() {
  const section = document.getElementById('accountSection');
  if (!section || ECHO.mode !== 'web') return;

  const state = await EchoSync.refresh();
  if (!state.enabled) { section.hidden = true; return; }
  section.hidden = false;

  const signedIn = !!(state.user && state.user.email);
  document.getElementById('accountSignedOut').hidden = signedIn;
  document.getElementById('accountSignedIn').hidden = !signedIn;
  if (signedIn) document.getElementById('accountEmail').textContent = state.user.email;
  return state;
}

document.getElementById('signInBtn')?.addEventListener('click', () => {
  // Full navigation, not fetch: this is an OAuth redirect to Google.
  window.location.href = '/api/auth/google';
});

document.getElementById('signOutBtn')?.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  // Drop the sync cursor too, so signing into a different account on this
  // browser starts from a clean slate rather than inheriting a cursor that
  // would skip that account's history.
  EchoSync.clearLocalSyncState();
  await renderAccountState();
  showToast('info', 'Signed out. Your library stays in this browser.');
});

document.getElementById('signOutAllBtn')?.addEventListener('click', async () => {
  // Ends every session for the account, on every device — the escape hatch
  // for a cookie left on a machine you no longer have.
  if (!confirm('Sign out of Echo on every device?')) return;
  await fetch('/api/auth/signout-everywhere', { method: 'POST' }).catch(() => {});
  EchoSync.clearLocalSyncState();
  await renderAccountState();
  showToast('info', 'Signed out everywhere. Your library stays in this browser.');
});

document.getElementById('syncNowBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('syncNowBtn');
  btn.disabled = true;
  const statusEl = document.getElementById('syncStatus');
  if (statusEl) statusEl.textContent = 'syncing…';
  await EchoSync.syncNow({ silent: false });
  if (statusEl) statusEl.textContent = 'library syncing';
  btn.disabled = false;
});

// On load: work out the account state, sync if signed in, and report the
// outcome of a sign-in redirect we have just come back from.
(async function initAccount() {
  if (ECHO.mode !== 'web') return;
  const state = await renderAccountState();

  const params = new URLSearchParams(location.search);
  const signin = params.get('signin');
  if (signin) {
    // Clean the flag out of the URL so a refresh does not re-toast.
    history.replaceState({}, document.title, location.pathname);
    if (signin === 'ok') showToast('success', 'Signed in — your library will sync across your devices.');
    else showToast('error', "Sign-in didn't complete. Please try again.");
  }

  if (state && state.user) EchoSync.syncNow({ silent: true });
})();

settingsSaveKeyBtnEl?.addEventListener('click', async () => {
  const v = apiKeyInputEl?.value || '';

  if (ECHO.mode !== 'web' && ECHO.mode !== 'desktop') {
    setApiKey(v);
    showToast('success', v.trim() ? 'API key saved.' : 'API key cleared.');
    closeSettingsModal();
    return;
  }

  const trimmed = v.trim();
  if (!trimmed) {
    setApiKey('');
    setKeyStatus('', '');
    showToast('info', 'API key cleared.');
    closeSettingsModal();
    return;
  }

  setKeyStatus('Checking…', '');
  settingsSaveKeyBtnEl.disabled = true;
  try {
    const res  = await fetch('/api/validate-key', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Echo-Api-Key': trimmed },
      body:    '{}',
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.valid) {
      setApiKey(trimmed);
      setKeyStatus('Key verified ✓', 'success');
      showToast('success', 'API key saved and verified.');
      closeSettingsModal();
    } else {
      const msg = data?.error?.message || 'That key looks invalid.';
      setKeyStatus(msg, 'error');
    }
  } catch (err) {
    console.error('[echo] validate-key network error:', err);
    setKeyStatus('Network error while checking the key.', 'error');
  } finally {
    settingsSaveKeyBtnEl.disabled = false;
  }
});

document.getElementById('settingsClearKeyBtn')?.addEventListener('click', () => {
  clearApiKey();
  if (apiKeyInputEl) apiKeyInputEl.value = '';
  setKeyStatus('', '');
  showToast('info', 'API key cleared.');
});

autoDigestToggleEl?.addEventListener('change', () => {
  setAutoDigest(autoDigestToggleEl.checked);
  showToast('info', autoDigestToggleEl.checked
    ? 'Auto-digest on — digests run automatically after fetching a transcript.'
    : 'Auto-digest off.');
});

autoTagToggleEl?.addEventListener('change', () => {
  setAutoTags(autoTagToggleEl.checked);
  showToast('info', autoTagToggleEl.checked
    ? 'Auto-suggest tags on — new saves without tags will get suggestions.'
    : 'Auto-suggest tags off.');
});

// Settings gear is available in all modes now (the auto-digest toggle lives here).
const settingsBtnEl = document.getElementById('settingsBtn');
if (settingsBtnEl) settingsBtnEl.hidden = false;
// The BYOK API-key section applies to web (required) and desktop (optional);
// hidden only in local mode, where the CLI is the sole AI path.
if (ECHO.mode !== 'web' && ECHO.mode !== 'desktop') {
  const apiKeySectionEl = document.getElementById('apiKeySection');
  if (apiKeySectionEl) apiKeySectionEl.hidden = true;
}

// Desktop-specific copy: the web note ("sent to this Echo server, which
// relays…") is inaccurate/over-scary on desktop, where the server runs
// locally on the user's own machine and the CLI is the default AI path.
if (ECHO.mode === 'desktop') {
  const apiKeyNoteEl = document.querySelector('#apiKeySection .settings-note');
  if (apiKeyNoteEl) {
    apiKeyNoteEl.textContent = 'Optional. Echo uses your local Claude CLI by default. Add an ' +
      'Anthropic API key only if you don’t have the CLI — it’s stored on this device ' +
      'and used to call Anthropic directly; nothing is sent to any other server.';
  }
  const apiKeyLabelEl = document.querySelector('label[for="apiKeyInput"]');
  if (apiKeyLabelEl && !/\(optional\)/i.test(apiKeyLabelEl.textContent)) {
    apiKeyLabelEl.textContent += ' (optional)';
  }
}

/**
 * POST helper for AI endpoints. In web mode, attaches the user's
 * BYOK Anthropic API key (if set) as the X-Echo-Api-Key header so
 * the server can use it instead of a server-side key. In local
 * mode this behaves exactly like a plain fetch (no extra header).
 *
 * @param {string} url
 * @param {object} body - request body, will be JSON.stringify'd
 * @param {{ signal?: AbortSignal }} [opts] - optional fetch options; signal
 *   lets a caller cancel the in-flight request (see runDigest()'s Stop button).
 * @returns {Promise<Response>}
 */
function aiFetch(url, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (ECHO.mode === 'web' || ECHO.mode === 'desktop') {
    const k = getApiKey();
    if (k) headers['X-Echo-Api-Key'] = k;
  }
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
}

/**
 * Guard called at the top of every AI-triggering handler. In web
 * mode, if no API key is stored yet, opens the settings modal,
 * shows a toast, and returns false so the caller can bail out
 * before doing any work. In local mode this always returns true.
 *
 * @returns {boolean}
 */
function requireApiKey() {
  if (ECHO.mode === 'web' && !getApiKey()) {
    openSettingsModal();
    showToast('info', 'Add your Anthropic API key to use AI features.');
    return false;
  }
  return true;
}

/* ==============================================
   FIRST-RUN ONBOARDING CARD (Task 2)
   Shown once on the initial empty state, before any transcript has ever
   loaded. Dismissible; dismissal (and reaching a loaded transcript) is
   remembered via localStorage so it never nags a returning user. In web
   mode with no stored key, also surfaces the BYOK requirement proactively
   instead of waiting for the reactive requireApiKey() popup.
=============================================== */
const ONBOARD_STORAGE_KEY = 'echo-onboarded';

function isOnboarded() {
  try { return localStorage.getItem(ONBOARD_STORAGE_KEY) === 'true'; }
  catch { return false; }
}

function markOnboarded() {
  try { localStorage.setItem(ONBOARD_STORAGE_KEY, 'true'); }
  catch { /* localStorage unavailable — non-fatal */ }
}

/** Shows the onboarding card on the pristine empty state (no-op once onboarded). */
function initOnboardCard() {
  if (isOnboarded()) return;
  const card = document.getElementById('onboardCard');
  if (!card) return;
  const keyNote = document.getElementById('onboardKeyNote');
  if (keyNote) {
    if (ECHO.mode === 'desktop') {
      // Soft, non-nagging framing — the CLI is the default, the key is optional.
      const noteTextEl = keyNote.querySelector('.onboard-card-text');
      if (noteTextEl) {
        noteTextEl.textContent = 'AI uses your local Claude CLI. No CLI? Add your ' +
          'Anthropic key in Settings — optional.';
      }
      keyNote.hidden = !!getApiKey();
    } else {
      keyNote.hidden = !(ECHO.mode === 'web' && !getApiKey());
    }
  }
  card.hidden = false;
}

document.getElementById('onboardDismissBtn')?.addEventListener('click', () => {
  markOnboarded();
  const card = document.getElementById('onboardCard');
  if (card) card.hidden = true;
});

document.getElementById('onboardAddKeyBtn')?.addEventListener('click', () => {
  openSettingsModal();
});

/* ==============================================
   LEGAL OVERLAY — Privacy / Terms (Task 4)
   Single shared modal (matches the shortcuts/settings modal pattern);
   content is swapped by JS depending on which footer link was clicked.
=============================================== */
const legalOverlayEl    = document.getElementById('legalOverlay');
const legalModalTitleEl = document.getElementById('legalModalTitle');
const legalModalBodyEl  = document.getElementById('legalModalBody');

const LEGAL_CONTENT = {
  privacy: {
    title: 'Privacy',
    body:
      '<p>Echo does not create an account or store your data on its servers in hosted mode — ' +
      'your library (saved transcripts, digests) lives entirely in your own browser ' +
      '(IndexedDB).</p>' +
      '<p>Your Anthropic API key is stored only in your browser’s localStorage. It is sent to ' +
      'this app’s server solely to relay your AI requests to Anthropic on your behalf — it is ' +
      'not persisted server-side and is not shared with any other party.</p>' +
      '<p>Transcripts you fetch are retrieved on demand and are not logged in web mode.</p>',
  },
  terms: {
    title: 'Terms',
    body:
      '<p>Echo is provided as-is, with no warranty of any kind.</p>' +
      '<p>You are responsible for your own Anthropic API usage and any costs it incurs.</p>' +
      '<p>Please respect YouTube’s Terms of Service when using this app.</p>' +
      '<p>Echo is not affiliated with, endorsed by, or sponsored by YouTube or Anthropic.</p>',
  },
};

function openLegalOverlay(kind) {
  if (!legalOverlayEl) return;
  const content = LEGAL_CONTENT[kind] || LEGAL_CONTENT.privacy;
  if (legalModalTitleEl) legalModalTitleEl.textContent = content.title;
  if (legalModalBodyEl)  legalModalBodyEl.innerHTML    = content.body;
  legalOverlayEl.hidden = false;
}

function closeLegalOverlay() {
  if (!legalOverlayEl) return;
  legalOverlayEl.hidden = true;
}

document.getElementById('footerPrivacyBtn')?.addEventListener('click', () => openLegalOverlay('privacy'));
document.getElementById('footerTermsBtn')?.addEventListener('click', () => openLegalOverlay('terms'));
document.getElementById('legalClose')?.addEventListener('click', closeLegalOverlay);
document.getElementById('legalBackdrop')?.addEventListener('click', closeLegalOverlay);

/** Returns true if the keyboard event originates from a form-entry context. */
function isTypingContext(e) {
  const t = e.target;
  if (!t) return false;
  const tag = (t.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (t.isContentEditable) return true;
  return false;
}

/** Global shortcut handler — ignores keystrokes that originate in form fields. */
document.addEventListener('keydown', e => {
  // Skip modifier combos
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  // All shortcuts (including '?') skip when typing in a form field —
  // otherwise pasting a YouTube URL containing '?' into #urlInput would
  // pop the shortcuts overlay and swallow the character.
  if (isTypingContext(e)) return;

  if (e.key === '?') {
    e.preventDefault();
    openShortcutsOverlay();
    return;
  }

  if (e.key === '/') {
    e.preventDefault();
    switchTab('transcript');
    findInput.focus();
    return;
  }

  if (e.key === '1') { e.preventDefault(); switchTab('transcript'); return; }
  if (e.key === '2') { e.preventDefault(); switchTab('digest');     return; }
  if (e.key === '3') { e.preventDefault(); libraryBtnClick();      return; }

  if (e.key === 't') {
    e.preventDefault();
    themeToggleBtn.click();
    return;
  }
});

/* ==============================================
   EXTENSION TRANSCRIPT HANDOFF
   The browser extension can scrape a transcript on the visitor's own
   YouTube tab (their IP, their session) and hand it here instead of making
   Echo's server fetch it — the fix for YouTube bot-blocking a hosted
   server's IP. The payload travels in the URL FRAGMENT, never sent to the
   server, so this is purely a client-side handoff: see
   extension/shared.js echoEncodeTranscript() for the writer.
=============================================== */

const ECHO_TX_HASH_KEY = 'echo-tx';

/**
 * Synchronously read the raw encoded transcript out of the URL fragment
 * (key 'echo-tx'), or '' if absent. Kept synchronous and side-effect-free so
 * autoLoadFromQuery() can grab it before the fragment is wiped by the
 * history.replaceState() cleanup below.
 * @returns {string}
 */
function readExtensionTranscriptHash() {
  try {
    if (!location.hash || location.hash.length < 2) return '';
    const params = new URLSearchParams(location.hash.slice(1)); // drop leading '#'
    return params.get(ECHO_TX_HASH_KEY) || '';
  } catch (e) { return ''; }
}

/**
 * Strictly validate a decoded extension transcript payload before it's
 * allowed to touch app state.
 *
 * THIS is the real trust boundary, not extension/background.js's copy of
 * these same rules. That copy only protects payloads that actually came
 * from Echo's own content script — but this fragment is just a URL, and a
 * hostile page can send a visitor to `<echo>/?v=…#echo-tx=…` with a
 * fabricated payload of its own, skipping the extension entirely. Nobody
 * upstream of this function should be trusted to have already checked it.
 *
 * @param {*} payload
 * @param {string} expectedVideoId - the ?v= id this page loaded for
 * @returns {boolean}
 */
function isValidExtensionTranscript(payload, expectedVideoId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;

  if (!Array.isArray(payload.segments)) return false;
  if (payload.segments.length < 1 || payload.segments.length > 50000) return false;
  for (const seg of payload.segments) {
    if (!seg || typeof seg !== 'object') return false;
    if (typeof seg.text !== 'string' || seg.text.length > 5000) return false;
    if (typeof seg.offset !== 'number' || !Number.isFinite(seg.offset)) return false;
  }

  if (typeof payload.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(payload.videoId)) return false;
  if (payload.videoId !== expectedVideoId) return false;

  for (const key of ['title', 'channel', 'channelUrl', 'langCode']) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.length > 500) return false;
  }

  return true;
}

/**
 * Decode + validate an extension-supplied transcript and, on success, apply
 * it exactly as a normal fetch would. Returns false on ANY failure (bad
 * base64, bad gzip, bad JSON, failed validation) so the caller can fall back
 * to fetchTranscript() — this path must degrade to today's behaviour, never
 * get stuck.
 *
 * @param {string} encoded - raw fragment value (base64url of gzip of JSON)
 * @param {string} expectedVideoId - the ?v= id this page loaded for
 * @returns {Promise<boolean>}
 */
async function applyExtensionTranscript(encoded, expectedVideoId) {
  try {
    if (!encoded || typeof DecompressionStream === 'undefined') return false;

    // base64url -> base64 -> raw bytes
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Bound the DECOMPRESSED size, not just the encoded one: gzip reaches
    // ~1000:1 on repetitive input, so the 1.5 MB fragment cap alone would
    // still allow a >1 GB expansion — and any page can link a visitor here.
    const MAX_DECOMPRESSED = 12_000_000;
    const gunzipped = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = gunzipped.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_DECOMPRESSED) { reader.cancel(); return false; }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { merged.set(c, at); at += c.length; }
    const json = new TextDecoder().decode(merged);
    const payload = JSON.parse(json);

    if (!isValidExtensionTranscript(payload, expectedVideoId)) return false;

    applyTranscriptResponse(payload);
    return true;
  } catch (e) {
    return false; // any failure here just means "fetch it ourselves instead"
  }
}

/** Returns true if a transcript fetch was kicked off. */
function autoLoadFromQuery() {
  try {
    const params = new URLSearchParams(location.search);
    const v   = params.get('v');
    const url = params.get('url');
    let target = '';
    if (v && /^[\w-]{11}$/.test(v)) {
      target = 'https://www.youtube.com/watch?v=' + v;
    } else if (url) {
      target = url;   // decoded automatically by URLSearchParams
    }
    if (!target) return false;
    if (typeof urlInput !== 'undefined' && urlInput) urlInput.value = target;

    // Grab the extension handoff (if any) BEFORE the cleanup below wipes it —
    // history.replaceState() to a bare pathname clears the query string AND
    // the fragment in one shot, so this has to happen first.
    const txEncoded = readExtensionTranscriptHash();

    // Clean the query string + fragment so a refresh doesn't re-trigger (or
    // re-apply a stale transcript) and the bar looks tidy.
    if (window.history && history.replaceState) {
      history.replaceState({}, document.title, location.pathname);
    }

    if (txEncoded && v) {
      // Extension path: decode+validate first, fetch only if that fails.
      applyExtensionTranscript(txEncoded, v).then((applied) => {
        if (!applied) fetchTranscript();
      });
    } else {
      // Kick off the normal transcript fetch
      fetchTranscript();
    }
    return true;
  } catch (e) { /* non-fatal: ignore malformed query */ return false; }
}

/** True if a ?v= or ?url= query param is present (explicit navigation). */
function hasQueryTarget() {
  try {
    const params = new URLSearchParams(location.search);
    return !!(params.get('v') || params.get('url'));
  } catch (e) { return false; }
}

/* ==============================================
   SESSION RESTORE — snapshot the working session to
   sessionStorage so refreshing the page doesn't lose the
   loaded transcript / digest.
=============================================== */
const SESSION_KEY = 'echo-session-v1';

/** Build a plain-object snapshot of the current working session, or null if nothing loaded. */
function buildSessionSnapshot() {
  if (!currentMeta) return null;
  return {
    videoId:    currentMeta.videoId,
    url:        currentMeta.url,
    title:      currentMeta.title,
    channel:    currentMeta.channel || null,
    channelUrl: currentMeta.channelUrl || null,
    transcriptSource: currentMeta.transcriptSource || 'captions',
    whisperModel: currentMeta.whisperModel || null,
    segments: currentSegments || lastSegments || null,
    digest:   currentDigest,
    suggestedTags: Array.isArray(currentSuggestedTags) ? currentSuggestedTags : [],
    digestUsageLine: (usageStatsEl && usageStatsEl.classList.contains('visible'))
      ? usageStatsEl.innerHTML
      : '',
    savedFlag:  Array.isArray(savedList) && savedList.some(e => e.videoId === currentMeta.videoId),
    viewMode:   getMode(),
    activeTab:  !paneDigest.hidden ? 'digest'
              : !paneSaved.hidden  ? 'saved'
              : 'transcript',
  };
}

/**
 * Persist the current session snapshot to sessionStorage.
 * On write failure (e.g. QuotaExceededError from an hour-long transcript's
 * segments array), retries without `segments` and flags `segmentsDropped`
 * so restore can fall back to a "press Get transcript" prompt instead of
 * guessing at content.
 */
function saveSession() {
  if (sessionRestoring) return; // never overwrite mid-restore
  let snap;
  try {
    snap = buildSessionSnapshot();
    if (!snap) { sessionStorage.removeItem(SESSION_KEY); return; }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(snap));
  } catch (e) {
    try {
      if (!snap) snap = buildSessionSnapshot();
      if (snap) {
        snap.segments        = null;
        snap.segmentsDropped = true;
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(snap));
      }
    } catch (e2) { /* sessionStorage unavailable entirely — give up silently */ }
  }
}

/** Clear any stored session snapshot (used when an explicit navigation should win). */
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
}

/**
 * Restore a previously-snapshotted session on boot, with no network call.
 * Returns true if a session was restored.
 */
function restoreSession() {
  let raw;
  try { raw = sessionStorage.getItem(SESSION_KEY); } catch (e) { return false; }
  if (!raw) return false;

  let snap;
  try { snap = JSON.parse(raw); } catch (e) { clearSession(); return false; }
  if (!snap || typeof snap !== 'object' || !snap.videoId || !snap.url) { clearSession(); return false; }

  sessionRestoring = true;
  try {
    if (snap.segmentsDropped || !Array.isArray(snap.segments) || snap.segments.length === 0) {
      // Segments were dropped (quota) or never captured — ask the user to
      // re-fetch rather than guessing at transcript content.
      urlInput.value = snap.url;
      setStatus('Session restored — press Enter in the link box to reload the transcript.');
      return true;
    }

    // Rebuild the same state the fetch-success path sets, purely from the snapshot.
    lastSegments      = snap.segments;
    currentSegments   = snap.segments;
    currentMeta       = {
      videoId: snap.videoId, url: snap.url, title: snap.title,
      channel: snap.channel || null, channelUrl: snap.channelUrl || null,
      transcriptSource: snap.transcriptSource || 'captions',
      whisperModel: snap.whisperModel || null,
    };
    currentDigest     = snap.digest || null;
    currentSuggestedTags = Array.isArray(snap.suggestedTags) ? snap.suggestedTags : [];
    urlInput.value = snap.url;

    if (snap.viewMode) {
      radios.forEach(r => { r.checked = (r.value === snap.viewMode); });
      syncToggleActive();
    }

    renderSegments(lastSegments);
    reApplyOverlays();
    updateNowReading();
    syncDigestExportRow();
    markOnboarded(); // a restored transcript session means the user is past first-run

    digestBtn.disabled              = false;
    saveBtn.disabled                = false;
    syncSaveButton(); // reflect library membership after a session restore
    transcriptCopyBtn.disabled      = false;
    transcriptDownloadBtn.disabled  = false;
    entryExportBtn.disabled         = !snap.savedFlag;
    syncDigestRegenBtn();

    // Restore digest pane
    if (snap.digest) {
      digestOutput.innerHTML =
        '<div class="digest-eyebrow">AI Digest</div>' +
        renderMarkdown(snap.digest);
      digestOutput.classList.add('visible');
      digestEmptySt.classList.add('is-hidden');
      digestDot.classList.remove('is-hidden');
      setDigestStatus('Digest ready.', false);
      if (snap.digestUsageLine) {
        usageStatsEl.innerHTML = snap.digestUsageLine;
        usageStatsEl.classList.add('visible');
      }
    }

    // Restore active tab — does not trigger the next-action nudge or any AI call.
    switchTab(['digest', 'saved'].includes(snap.activeTab) ? snap.activeTab : 'transcript');

    setStatus(`Session restored — ${lastSegments.length} segment${lastSegments.length === 1 ? '' : 's'}.`);
    return true;
  } finally {
    sessionRestoring = false;
  }
}

/* ==============================================
   INITIALISE
=============================================== */
loadSaved();
let _restored = false;
if (hasQueryTarget()) {
  // Explicit navigation (?v=/?url=) always wins over a restored session.
  clearSession();
} else {
  _restored = restoreSession();
}
const _autoLoaded = autoLoadFromQuery();
// Autofocus the URL input for a fast paste-and-go flow — but not when we're
// about to auto-fetch from a query param, or when a session was just restored
// (focus would be a distraction in either case). Same guard applies to the
// first-run onboarding card — no point showing it if we're about to replace
// #output's contents anyway.
if (!_autoLoaded && !_restored) {
  urlInput.focus();
  initOnboardCard();
}

/* ==============================================
   HERO WAVEFORM
   Was an inline <script> mid-body; moved here so no inline script remains
   and script-src can drop 'unsafe-inline'. It is self-contained and guards
   on its own element, so running at end-of-body is equivalent.
=============================================== */
/* Build the hero waveform bars with a deterministic organic stagger. */
(function () {
  var wave = document.getElementById('heroWave');
  if (!wave) return;
  var N = 38;
  for (var i = 0; i < N; i++) {
    var s = document.createElement('span');
    var d = Math.sin(i * 0.5) * 0.5 + 0.5;
    s.style.animationDelay = (-(d * 1.9)).toFixed(2) + 's';
    s.style.animationDuration = (1.5 + d * 0.9).toFixed(2) + 's';
    wave.appendChild(s);
  }
})();

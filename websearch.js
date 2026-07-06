// ---------------------------------------------------------------------------
// Server-side web search for the AI "enrich" (RAG) feature.
//
// WHY THIS FILE EXISTS: Echo shells out to the local `claude -p` CLI for all
// AI reasoning, and that CLI has NO live web-search capability — when asked
// to "look something up" it silently fabricates plausible-looking citations
// instead of failing loudly (verified empirically). To let enrich() ground
// its "background"/"factcheck" answers in real, current sources, the SERVER
// itself performs the web search here, fetches real result URLs + snippets,
// and hands ONLY that fetched text to the CLI — the model then reasons over
// real material instead of inventing it. See digest.js's enrich().
// ---------------------------------------------------------------------------

const SEARCH_ENDPOINT = 'https://lite.duckduckgo.com/lite/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

const HTML_ENTITIES = {
  '&amp;': '&',
  '&#x27;': "'",
  '&#39;': "'",
  '&quot;': '"',
  '&lt;': '<',
  '&gt;': '>',
  '&#x2F;': '/',
  '&#47;': '/',
  '&nbsp;': ' ',
};

/**
 * Decode common HTML entities and strip any leftover HTML tags from a
 * fragment of scraped HTML text.
 *
 * @param {string} raw
 * @returns {string}
 */
function decodeHtml(raw) {
  let s = String(raw || '');
  s = s.replace(/&#x?[0-9a-fA-F]+;|&\w+;/g, (m) => {
    if (HTML_ENTITIES[m]) return HTML_ENTITIES[m];
    // Numeric entities not in the lookup table (decimal or hex).
    const hexMatch = m.match(/^&#x([0-9a-fA-F]+);$/);
    if (hexMatch) return String.fromCodePoint(parseInt(hexMatch[1], 16));
    const decMatch = m.match(/^&#(\d+);$/);
    if (decMatch) return String.fromCodePoint(parseInt(decMatch[1], 10));
    return m;
  });
  // Strip any leftover tags.
  s = s.replace(/<[^>]*>/g, '');
  return s.trim();
}

/**
 * Resolves a DuckDuckGo lite result href into a real destination URL.
 * DDG lite wraps external links as `//duckduckgo.com/l/?uddg=<encoded>&...`;
 * unwrap those to the real URL. Returns null for links that still point at
 * duckduckgo.com after unwrapping (internal/ad links we don't want).
 *
 * @param {string} href
 * @returns {string|null}
 */
function resolveHref(href) {
  let url = String(href || '').trim();
  if (!url) return null;

  const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
  if (uddgMatch) {
    try {
      url = decodeURIComponent(uddgMatch[1]);
    } catch (_) {
      // leave url as-is if decoding fails
    }
  }

  if (url.startsWith('//')) url = 'https:' + url;

  try {
    const host = new URL(url).host;
    if (host.includes('duckduckgo.com')) return null;
  } catch (_) {
    return null;
  }

  // Reject any non-http(s) scheme (e.g. javascript:, file:, data:).
  // new URL('javascript:...').host returns '' so the duckduckgo check above
  // does NOT catch these — this guard is the last line of defence before the
  // URL is handed to callers and eventually rendered as a clickable link.
  if (!/^https?:\/\//i.test(url)) return null;

  return url;
}

export { resolveHref };

/**
 * Runs a web search via DuckDuckGo's lite HTML endpoint and returns a list
 * of { title, url, snippet } results. Never throws — any network, timeout,
 * or parse failure resolves to an empty array so callers can treat "no
 * results" uniformly whether the search truly found nothing or failed.
 *
 * @param {string} query
 * @param {{ n?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<Array<{ title: string, url: string, snippet: string }>>}
 */
export async function searchWeb(query, { n = 5, timeoutMs = 8000 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = new URLSearchParams({ q });

    const resp = await fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!resp.ok) return [];

    const html = await resp.text();

    // Collect (position, {title, href}) for each result link, and
    // (position, snippet) for each snippet cell, then pair them in
    // document order. DuckDuckGo lite's real markup mixes single/double
    // quotes and attribute order (e.g. `href="..." class='result-link'`),
    // so the regexes below tolerate either quote style and either
    // href-before-class or class-before-href ordering.
    const linkRe = /<a\b(?=[^>]*\bclass=['"]result-link['"])(?=[^>]*\bhref=['"]([^'"]*)['"])[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRe = /<td\b[^>]*\bclass=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

    const links = [];
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      links.push({ pos: m.index, href: m[1], title: decodeHtml(m[2]) });
    }

    const snippets = [];
    while ((m = snippetRe.exec(html)) !== null) {
      snippets.push({ pos: m.index, text: decodeHtml(m[1]) });
    }

    const results = [];
    let snippetCursor = 0;
    for (const link of links) {
      if (results.length >= n) break;

      const url = resolveHref(link.href);
      if (!url || !link.title) continue;

      // Advance the cursor to the next snippet after this link's position,
      // pairing each link with the next unused snippet in document order.
      while (snippetCursor < snippets.length && snippets[snippetCursor].pos < link.pos) {
        snippetCursor++;
      }
      const snippetEntry = snippets[snippetCursor];
      if (snippetEntry) snippetCursor++;

      results.push({
        title: link.title,
        url,
        snippet: snippetEntry ? snippetEntry.text : '',
      });
    }

    return results;
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

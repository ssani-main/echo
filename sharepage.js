// sharepage.js — renders a published digest as a standalone, self-contained
// public HTML page. No external scripts/styles/fonts; everything inline and
// locked down with a strict Content-Security-Policy.
//
// Security model: every string that originates from user/AI-controlled data
// (title, digestMd, claims, sourceUrl, ...) is escaped BEFORE any markdown or
// template transform runs. Only http(s) URLs are ever emitted into href
// attributes; every other scheme (javascript:, data:, file:, vbscript:, ...)
// is dropped. See escapeHtml/escapeAttr/safeHttpUrl below.

/**
 * Escapes the five HTML-significant characters. Safe for use inside text
 * nodes AND inside quoted attribute values (it escapes quotes too).
 * @param {*} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Alias kept for parity with the frontend's escapeAttr() naming — same
 * escaping is safe for both text content and attribute values.
 * @param {*} s
 * @returns {string}
 */
export function escapeAttr(s) {
  return escapeHtml(s);
}

/**
 * Returns `u` unchanged only if it is a well-formed http(s) URL; otherwise
 * returns '' so callers never emit an unsafe scheme (javascript:, data:,
 * file:, vbscript:, etc.) into an href/src attribute.
 * @param {*} u
 * @returns {string}
 */
export function safeHttpUrl(u) {
  const s = String(u ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    // eslint-disable-next-line no-new
    new URL(s);
  } catch {
    return '';
  }
  return s;
}

/**
 * Compact, escape-first markdown -> HTML renderer. HTML is escaped from the
 * raw source FIRST; every subsequent transform operates on the already-safe
 * string and only ever introduces a small, fixed allow-list of tags
 * (h1/h2/h3/p/ul/ol/li/blockquote/pre/code/strong/em/a/hr). Links are
 * restricted to http(s) via safeHttpUrl(); any other scheme collapses to
 * plain text.
 * @param {string} md
 * @returns {string}
 */
export function renderMarkdown(md) {
  function inlineMarkdown(s) {
    // Inline code spans first — protect contents from later transforms.
    const codeSpans = [];
    s = s.replace(/`([^`]+)`/g, (m, code) => {
      codeSpans.push(code);
      return ` CODE${codeSpans.length - 1} `;
    });

    // [text](url) — only accept safe http(s) URLs, else drop the link and
    // keep the plain text.
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
      const href = safeHttpUrl(url);
      return href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>`
        : text;
    });

    // **bold** / __bold__
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
         .replace(/__(.+?)__/g, '<strong>$1</strong>');

    // *italic* / _italic_
    s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
         .replace(/(^|[^_])_([^_\s][^_]*?)_(?!_)/g, '$1<em>$2</em>');

    // Restore protected code spans
    s = s.replace(/ CODE(\d+) /g, (m, i) => `<code>${codeSpans[Number(i)]}</code>`);

    return s;
  }

  const lines = escapeHtml(md).split('\n');
  const html = [];
  let paraBuffer = [];
  let quoteBuffer = [];
  let inBlockquote = false;
  let inCodeBlock = false;
  let codeBuffer = [];
  const listStack = []; // [{ indent, type: 'ul'|'ol' }]

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
    quoteBuffer = [];
    inBlockquote = false;
  }

  function closeLists(toIndent = -1) {
    while (listStack.length && listStack[listStack.length - 1].indent > toIndent) {
      const top = listStack.pop();
      html.push(`</${top.type}>`);
    }
  }

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
    if (/^```/.test(line.trim())) {
      if (!inCodeBlock) {
        flushPara(); flushQuote(); closeLists();
        inCodeBlock = true;
        codeBuffer = [];
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

    // ### heading (checked before ##)
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
    // # heading
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

    // Regular text line — accumulate into paragraph buffer.
    closeLists();
    paraBuffer.push(line.trim());
  }

  if (inCodeBlock && codeBuffer.length) {
    html.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
  }
  flushPara();
  flushQuote();
  closeLists();

  return html.join('\n');
}

const CLAIM_STATUS_META = {
  supported: { label: 'Supported', symbol: '✓', className: 'claim-supported' },
  unsupported: { label: 'Unsupported', symbol: '⚠', className: 'claim-unsupported' },
  mixed: { label: 'Mixed', symbol: '~', className: 'claim-mixed' },
  unverifiable: { label: 'Unverifiable', symbol: '?', className: 'claim-unverifiable' },
};

// Canonical status order — used for the claims-summary counts so the summary
// itself is never internally contradictory. The ledger ROWS intentionally
// keep the caller's original `claims` array order (never reordered), so this
// order will not always line up with the row order below it; that's expected.
const CLAIM_STATUS_ORDER = ['supported', 'mixed', 'unsupported', 'unverifiable'];

/**
 * The waveform brand mark: 6 vertical rounded bars on a 0 0 62 26 viewBox.
 * Reused in the hero header and the footer CTA. `variant` adds a modifier
 * class so CSS can stagger a one-time reveal animation on the hero copy
 * only (footer copy stays static).
 * @param {string} [variant]
 * @returns {string}
 */
function waveformSvg(variant = '') {
  const cls = variant ? ` waveform--${variant}` : '';
  const bars = [
    { x: 0, h: 8 },
    { x: 11, h: 15 },
    { x: 22, h: 23 },
    { x: 33, h: 23 },
    { x: 44, h: 14 },
    { x: 55, h: 9 },
  ];
  const rects = bars
    .map((b, i) => {
      const y = (26 - b.h) / 2;
      return `<rect class="wf-bar" style="--wf-i:${i}" x="${b.x}" y="${y}" width="7" height="${b.h}" rx="1.6"/>`;
    })
    .join('');
  return `<svg class="waveform${cls}" width="34" height="14" viewBox="0 0 62 26" fill="currentColor" aria-hidden="true" focusable="false">${rects}</svg>`;
}

/**
 * Tallies claim statuses for the ledger summary row. Unknown/missing
 * statuses fall back to "unverifiable", matching renderClaim's fallback.
 * @param {Array<{status?:string}>} claims
 * @returns {Record<string, number>}
 */
function summarizeClaimStatuses(claims) {
  const counts = { supported: 0, unsupported: 0, mixed: 0, unverifiable: 0 };
  for (const claim of claims) {
    const key = CLAIM_STATUS_META[claim?.status] ? claim.status : 'unverifiable';
    counts[key] += 1;
  }
  return counts;
}

function renderClaim(claim) {
  const meta = CLAIM_STATUS_META[claim?.status] || CLAIM_STATUS_META.unverifiable;
  const claimText = escapeHtml(claim?.claim ?? '');
  const note = claim?.note ? `<p class="claim-note">${escapeHtml(claim.note)}</p>` : '';
  const sources = Array.isArray(claim?.sources)
    ? claim.sources
        .map((src) => {
          const url = typeof src === 'string' ? src : src?.url;
          const label = typeof src === 'string' ? src : (src?.title || src?.url || '');
          const href = safeHttpUrl(url);
          if (!href) return '';
          return `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(label)}</a>`;
        })
        .filter(Boolean)
        .join(', ')
    : '';
  const sourcesHtml = sources ? `<p class="claim-sources">Sources: ${sources}</p>` : '';

  return `
      <li class="claim-item ${meta.className}">
        <span class="claim-label ${meta.className}" title="${escapeAttr(meta.label)}">${escapeHtml(meta.label)} <span class="claim-symbol" aria-hidden="true">${meta.symbol}</span></span>
        <p class="claim-text">${claimText}</p>
        ${note}
        ${sourcesHtml}
      </li>`;
}

function renderClaimsSection(claims) {
  if (!Array.isArray(claims) || claims.length === 0) return '';
  const counts = summarizeClaimStatuses(claims);
  const countLabels = { supported: 'supported', unsupported: 'unsupported', mixed: 'mixed', unverifiable: 'unverifiable' };
  const summaryParts = CLAIM_STATUS_ORDER
    .filter((key) => counts[key] > 0)
    .map((key) => `<span class="claims-count claim-${key}">${counts[key]} ${countLabels[key]}</span>`)
    .join('<span class="claims-count-sep">·</span>');

  return `
    <section class="claims-section">
      <div class="claims-eyebrow-row">
        <h2 class="claims-eyebrow">Key claims</h2>
        <div class="claims-summary"><span class="claims-total">${claims.length} checked</span>${summaryParts ? `<span class="claims-summary-sep">·</span>${summaryParts}` : ''}</div>
      </div>
      <ul class="claims-list">
        ${claims.map(renderClaim).join('\n')}
      </ul>
    </section>`;
}

function formatCreatedAt(createdAt) {
  if (!createdAt) return '';
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return escapeHtml(String(createdAt));
  return d.toISOString().slice(0, 10);
}

/**
 * Builds the mono "signal readout" strip under the hero title. Items are
 * omitted cleanly (no dangling separators) when their data is absent. The
 * strip is a flex-wrap container with `gap`, and separators are rendered as
 * their own real elements *between* items (never before the first one) —
 * this avoids a stranded "·" landing at the START of a wrapped line on
 * narrow/mobile viewports, which a CSS `::before`-on-adjacent-sibling
 * separator cannot reliably avoid once the flex line wraps.
 * @param {{ watchHref: string, claimsCount: number, createdLabel: string }} args
 * @returns {string}
 */
function renderSignalReadout({ watchHref, claimsCount, createdLabel }) {
  const items = [];
  items.push('<span class="readout-item readout-digest"><span class="readout-dot" aria-hidden="true"></span>Digest</span>');
  if (watchHref) {
    items.push(
      `<span class="readout-item">Source ▸ <a class="readout-link" href="${watchHref}" target="_blank" rel="noopener noreferrer nofollow">Watch on YouTube ↗</a></span>`
    );
  }
  if (claimsCount > 0) {
    items.push(`<span class="readout-item">${claimsCount} claim${claimsCount === 1 ? '' : 's'} checked</span>`);
  }
  if (createdLabel) {
    items.push(`<span class="readout-item">${escapeHtml(createdLabel)}</span>`);
  }
  const sep = '<span class="readout-sep" aria-hidden="true">·</span>';
  return `<div class="signal-readout">${items.join(sep)}</div>`;
}

/**
 * Renders a published digest as a complete, standalone, self-contained
 * public HTML page (no external scripts/styles/fonts — safe to serve as-is).
 * @param {{ id?: string, title?: string, sourceUrl?: string, digestMd?: string,
 *   claims?: Array<{claim:string,status:string,note?:string,sources?:Array}>,
 *   createdAt?: string|number|Date }} params
 * @returns {string} a complete `<!doctype html>...</html>` document
 */
export function renderSharePage({ id, title, sourceUrl, digestMd, claims, createdAt } = {}) {
  const safeTitle = escapeHtml(title || 'Untitled digest');
  const watchHref = safeHttpUrl(sourceUrl);
  const digestHtml = renderMarkdown(digestMd || '');
  const claimsHtml = renderClaimsSection(claims);
  const createdLabel = formatCreatedAt(createdAt);
  const pageId = escapeAttr(id || '');
  const claimsArr = Array.isArray(claims) ? claims : [];
  const readoutHtml = renderSignalReadout({ watchHref, claimsCount: claimsArr.length, createdLabel });

  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data: https:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  return `<!doctype html>
<html lang="en" data-share-id="${pageId}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${safeTitle} — Echo</title>
<style>
  :root {
    --paper:      #0A0B0D;
    --surface:    #111419;
    --surface-2:  #171B22;
    --ink:        #EAEDF2;
    --muted:      #99A1AD;
    --faint:      #5B636E;
    --rule:       #22272F;
    --rule-2:     #2E343D;
    --accent:     #3DE0C8;
    --accent-ink: #04120E;
    --ok:         #45D9A6;
    --warn:       #FF6B6B;
    --amber:      #F5A623;
    --neutral:    #7C8593;
    --radius:     9px;
    --radius-sm:  6px;
    --radius-lg:  14px;
    --font-display: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    --font-read:    'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif;
    --font-mono:    ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Mono', Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --paper:      #FBFBFC;
      --surface:    #FFFFFF;
      --surface-2:  #F5F6F8;
      --ink:        #0F1319;
      --muted:      #59616C;
      --faint:      #97A0AB;
      --rule:       #E9EBEF;
      --rule-2:     #D8DCE2;
      --accent:     #0FA98D;
      --accent-ink: #FFFFFF;
      --ok:         #0E9E75;
      --warn:       #D64545;
      --amber:      #92600A;
      --neutral:    #6B7480;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    position: relative;
    background: var(--paper);
    color: var(--ink);
    font-family: var(--font-display);
    line-height: 1.6;
    padding: 3rem 1.25rem 4rem;
    isolation: isolate;
  }
  /* A whisper of atmosphere behind the hero — dark only, restrained. */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background: radial-gradient(60rem 26rem at 50% -8%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 70%);
    opacity: 0.06;
  }
  @media (prefers-color-scheme: light) {
    body::before { display: none; }
  }
  .page {
    max-width: 42rem;
    margin: 0 auto;
  }

  /* ---------- Hero header ---------- */
  .hero { padding-bottom: 1.75rem; margin-bottom: 2rem; border-bottom: 1px solid var(--rule); }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--accent);
    margin-bottom: 1.1rem;
  }
  .waveform { color: var(--accent); flex: none; }
  .waveform .wf-bar {
    transform-origin: center;
    animation: wf-in 0.5s cubic-bezier(.2,.8,.2,1) both;
    animation-delay: calc(var(--wf-i, 0) * 55ms);
  }
  @media (prefers-reduced-motion: reduce) {
    .waveform .wf-bar { animation: none; }
  }
  @keyframes wf-in {
    from { opacity: 0; transform: scaleY(0.35); }
    to   { opacity: 1; transform: scaleY(1); }
  }
  .brand-word {
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: 0.82rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink);
  }
  h1.share-title {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 2rem;
    line-height: 1.15;
    letter-spacing: -0.01em;
    color: var(--ink);
    margin: 0 0 0.9rem;
  }
  .signal-readout {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem 0.55rem;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .readout-sep {
    color: var(--rule-2);
  }
  .readout-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 0.4rem;
    border-radius: 1px;
    transform: rotate(45deg);
    background: var(--accent);
  }
  .readout-link { color: var(--accent); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); }
  .readout-link:hover { border-bottom-color: var(--accent); }

  /* ---------- Digest body ---------- */
  main.digest {
    font-family: var(--font-read);
    font-size: 1.075rem;
    line-height: 1.7;
    color: var(--ink);
  }
  main.digest h1, main.digest h2, main.digest h3 {
    font-family: var(--font-display);
    color: var(--ink);
    line-height: 1.3;
  }
  main.digest h1 { font-size: 1.5rem; font-weight: 700; margin: 2rem 0 0.7rem; }
  main.digest h2 { font-size: 1.3rem; font-weight: 650; margin: 2rem 0 0.7rem; }
  main.digest h3 { font-size: 1.1rem; font-weight: 650; margin: 1.6rem 0 0.5rem; }
  main.digest h1:first-child, main.digest h2:first-child, main.digest h3:first-child { margin-top: 0; }
  main.digest p { margin: 0 0 1.05rem; }
  main.digest ul, main.digest ol { margin: 0 0 1.05rem 1.3rem; padding: 0; }
  main.digest li { margin-bottom: 0.4rem; }
  main.digest blockquote {
    margin: 0 0 1.05rem;
    padding: 0.6rem 1.05rem;
    border-left: 3px solid var(--accent);
    background: var(--surface-2);
    color: var(--muted);
    font-style: italic;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }
  main.digest pre {
    background: var(--surface-2);
    border: 1px solid var(--rule);
    border-radius: var(--radius-sm);
    padding: 0.85rem 1rem;
    overflow-x: auto;
    margin: 0 0 1.05rem;
    font-family: var(--font-mono);
    font-size: 0.82rem;
  }
  main.digest code {
    font-family: var(--font-mono);
    font-size: 0.86em;
    background: var(--surface-2);
    padding: 0.1em 0.35em;
    border-radius: 4px;
  }
  main.digest pre code { background: none; padding: 0; }
  main.digest a { color: var(--accent); text-underline-offset: 2px; }
  main.digest hr { border: none; border-top: 1px solid var(--rule); margin: 1.75rem 0; }

  /* ---------- Claims ledger ---------- */
  .claims-section { margin-top: 2.5rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); }
  .claims-eyebrow-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.9rem;
  }
  .claims-eyebrow {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--faint);
    margin: 0;
  }
  .claims-summary {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    letter-spacing: 0.02em;
    color: var(--muted);
  }
  .claims-total { color: var(--muted); }
  .claims-summary-sep, .claims-count-sep { margin: 0 0.4rem; color: var(--rule-2); }
  .claims-count.claim-supported    { color: var(--ok); }
  .claims-count.claim-unsupported  { color: var(--warn); }
  .claims-count.claim-mixed        { color: var(--amber); }
  .claims-count.claim-unverifiable { color: var(--neutral); }

  .claims-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.55rem; }
  .claim-item {
    background: var(--surface);
    border: 1px solid var(--rule);
    border-left: 3px solid var(--neutral);
    border-radius: var(--radius-sm);
    padding: 0.7rem 0.9rem;
  }
  .claim-item.claim-supported    { border-left-color: var(--ok); }
  .claim-item.claim-mixed        { border-left-color: var(--amber); }
  .claim-item.claim-unsupported  { border-left-color: var(--warn); }
  .claim-item.claim-unverifiable { border-left-color: var(--neutral); }

  .claim-label {
    display: block;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin-bottom: 0.3rem;
  }
  .claim-symbol { display: inline-block; }
  .claim-label.claim-supported    { color: var(--ok); }
  .claim-label.claim-unsupported  { color: var(--warn); }
  .claim-label.claim-mixed        { color: var(--amber); }
  .claim-label.claim-unverifiable { color: var(--neutral); }

  .claim-text { font-family: var(--font-display); font-size: 0.98rem; font-weight: 500; color: var(--ink); margin: 0 0 0.25rem; }
  .claim-note, .claim-sources { font-size: 0.85rem; color: var(--muted); margin: 0.15rem 0 0; }
  .claim-sources a { color: var(--accent); }

  /* ---------- Footer CTA ---------- */
  .cta-card {
    margin-top: 3rem;
    background: var(--surface-2);
    border: 1px solid var(--rule);
    border-radius: var(--radius-lg);
    padding: 1.75rem;
    text-align: center;
  }
  .cta-card .waveform { color: var(--accent); margin: 0 auto 0.9rem; display: block; }
  .cta-card .waveform .wf-bar { animation: none; }
  .cta-headline {
    font-family: var(--font-display);
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--ink);
    margin: 0 0 0.5rem;
  }
  .cta-sub { color: var(--muted); font-size: 0.92rem; margin: 0 0 1.25rem; }
  .cta-button {
    display: inline-block;
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 0.85rem;
    letter-spacing: 0.02em;
    text-decoration: none;
    background: var(--accent);
    color: var(--accent-ink);
    border-radius: var(--radius-sm);
    padding: 0.6rem 1.3rem;
  }
  .cta-button:hover { filter: brightness(1.08); }

  footer.share-footer {
    margin-top: 1.75rem;
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--faint);
  }

  a:focus-visible, .cta-button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  @media (max-width: 480px) {
    body { padding: 2rem 1rem 3rem; }
    h1.share-title { font-size: 1.6rem; }
    .cta-card { padding: 1.35rem; }
  }
</style>
</head>
<body>
  <div class="page">
    <header class="hero">
      <div class="brand">
        ${waveformSvg('hero')}
        <span class="brand-word">Echo</span>
      </div>
      <h1 class="share-title">${safeTitle}</h1>
      ${readoutHtml}
    </header>
    <main class="digest">
      ${digestHtml}
    </main>
    ${claimsHtml}
    <section class="cta-card">
      ${waveformSvg('cta')}
      <p class="cta-headline">Read it, don’t watch it.</p>
      <p class="cta-sub">Echo turns a YouTube link into a clean, readable digest — like this one.</p>
      <a class="cta-button" href="/">Try Echo →</a>
    </section>
    <footer class="share-footer">
      <span>Generated by Echo</span>
      <span>${escapeHtml(createdLabel)}</span>
    </footer>
  </div>
</body>
</html>`;
}

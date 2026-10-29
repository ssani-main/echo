// Echo's API routes ported to Seshat (see PORT.md). server.js forwards the routes it lists as ported
// here, after its own middleware (security headers, requireApproved, blockInWeb, rate limits), with
// ECHO_SESHAT_URL and ECHO_SESHAT_SECRET set. Anything on this machine can reach the port, so every
// request must carry that secret in x-echo-forward.
//
//   ECHO_SESHAT_SECRET=<32+ chars> seshat run seshat/server.ts      (ECHO_SESHAT_PORT, default 8001)

import { DEFAULT_PROVIDER_ID, getProviderId, getReasoningLevel, publicProviderList, type PublicProvider } from './providers.ts';
import { thresholdCharsFor } from './digest.ts';
import { logEvent } from './usagelog.ts';

// Same derivation as server.js: an unrecognised value is local.
const ECHO_MODE = process.env.ECHO_MODE === 'web' ? 'web' : process.env.ECHO_MODE === 'desktop' ? 'desktop' : 'local';
const isWeb = ECHO_MODE === 'web';

const portNumber = Number(process.env.ECHO_SESHAT_PORT ?? '8001');
const port = Number.isInteger(portNumber) && portNumber > 0 ? portNumber : 8001;

const secret = process.env.ECHO_SESHAT_SECRET ?? '';
if (secret.length < 32) {
  console.error('ECHO_SESHAT_SECRET must be set (32+ characters), the same value as for server.js.');
  process.exit(1);
}

// x-echo-mode: server.js refuses an answer made in another mode than its own.
const bare: Record<string, string> = { 'x-served-by': 'seshat', 'x-echo-mode': ECHO_MODE };
// Express's spelling of the JSON type, so a forwarded answer's headers match server.js's own.
const headers: Record<string, string> = { ...bare, 'content-type': 'application/json; charset=utf-8' };

interface ErrorBody { error: { code: string; message: string; hint: string } }

/** server.js's sendError envelope, without the optional reason/detail (no ported route sends them yet). */
function sendError(code: string, message: string, hint: string, status: number): Response {
  console.error(`[echo] ${code}: ${message}`);
  const body: ErrorBody = { error: { code, message, hint } };
  return Response.json(body, { status, headers });
}

/** A request that didn't come through server.js. Compared in full; the secret isn't a user's input. */
function notForwarded(req: Request): boolean {
  return req.headers.get('x-echo-forward') !== secret;
}

interface Health { status: string; mode: string }

function health(): Response {
  const body: Health = { status: 'ok', mode: ECHO_MODE };
  return Response.json(body, { headers });
}

interface ServedProvider extends PublicProvider { longPathThresholdChars: number }
interface ProvidersBody { providers: ServedProvider[]; default: string; defaultThinking: string }

/** GET /api/providers: the registry the pickers are built from (server.js has the reasoning). */
function providers(): Response {
  const available = publicProviderList({ isWeb });
  const list: ServedProvider[] = available.map((p) => ({ ...p, longPathThresholdChars: thresholdCharsFor({ provider: p.id }) }));
  const preferred = getProviderId({});
  const fallback = available.length > 0 ? available[0]!.id : DEFAULT_PROVIDER_ID;
  const defaultId = list.some((p) => p.id === preferred) ? preferred : fallback;
  const body: ProvidersBody = { providers: list, default: defaultId, defaultThinking: getReasoningLevel({}) };
  return Response.json(body, { headers });
}

// server.js's express.json({ limit: '5mb' }): body-parser's 5 MiB, a body of exactly that much is read.
const BODY_LIMIT = 5 * 1024 * 1024;

interface JsonBody { value: unknown; error: Response | undefined }

/**
 * The request body as express.json() leaves req.body: {} unless the type is application/json, {} for an
 * empty body, and server.js's own 413 and 400 envelopes (its error middleware) for too large and not JSON,
 * where body-parser's strict mode takes only an object or an array.
 * shortcut: no charset or content-encoding handling (Node answers a gzipped or latin1 body; here it would be
 * read as UTF-8), and a chunked body is read whole before the size check. Behind server.js neither happens,
 * as express.json() has already read the body; needed by the front-door swap (step 9).
 */
async function jsonBody(req: Request): Promise<JsonBody> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return { value: {}, error: undefined };
  if (Number(req.headers.get('content-length')) > BODY_LIMIT) return tooLarge();
  const bytes = await req.bytes();
  if (bytes.length > BODY_LIMIT) return tooLarge();
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) return { value: {}, error: undefined };
  const first = /^[\x20\x09\x0a\x0d]*([^\x20\x09\x0a\x0d])/.exec(text);
  if (!first || (first[1] !== '{' && first[1] !== '[')) return notJson();
  try {
    const value: unknown = JSON.parse(text);
    return { value, error: undefined };
  } catch {
    return notJson();
  }
}

function tooLarge(): JsonBody {
  const hint = 'Echo sends large libraries in batches — if you are seeing this, try syncing again.';
  return { value: undefined, error: sendError('TRANSCRIPT_UNAVAILABLE', 'That request is too large.', hint, 413) };
}

function notJson(): JsonBody {
  return { value: undefined, error: sendError('INTERNAL', 'That request body was not valid JSON.', '', 400) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// What happens to a digest after it is read happens in the browser, so the meter only learns it if the page
// says so. Names are an allow-list: this writes to a local file and must not become a way to write lines.
const CLIENT_EVENTS = new Set(['digest-copy', 'digest-download', 'digest-print', 'entry-export']);

/** POST /api/event: one line in the usage log (none in web mode), 204. */
async function clientEvent(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  if (body.error) return body.error;
  const fields = isRecord(body.value) ? body.value : {};
  const event = fields.event;
  const videoId = fields.videoId;
  if (typeof event !== 'string' || !CLIENT_EVENTS.has(event)) return sendError('INTERNAL', 'Unknown event.', '', 400);
  logEvent(event, { videoId: typeof videoId === 'string' ? videoId.slice(0, 32) : null, ok: true });
  // shortcut: `undefined`, because Seshat refuses TypeScript's `null` body (gap: response-null-body). `null` once fixed.
  return new Response(undefined, { status: 204, headers: bare });
}

/** Every route checks this first: refuse what didn't come through server.js. */
function refused(req: Request): Response | undefined {
  return notForwarded(req) ? sendError('FORBIDDEN', 'Not forwarded by Echo.', '', 403) : undefined;
}

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  routes: {
    "/api/health": { GET: (req) => refused(req) ?? health() },
    "/api/providers": { GET: (req) => refused(req) ?? providers() },
    "/api/event": { POST: async (req) => refused(req) ?? await clientEvent(req) },
  },
  fetch() {
    return sendError('NOT_FOUND', 'Not found.', '', 404);
  },
});
console.log(`Echo's Seshat service on ${server.url} (mode ${ECHO_MODE})`);

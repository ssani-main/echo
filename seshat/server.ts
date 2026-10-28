// Echo's API routes ported to Seshat (see PORT.md). server.js forwards the routes it lists as ported
// here, after its own middleware (security headers, requireApproved, blockInWeb, rate limits), with
// ECHO_SESHAT_URL and ECHO_SESHAT_SECRET set. Anything on this machine can reach the port, so every
// request must carry that secret in x-echo-forward.
//
//   ECHO_SESHAT_SECRET=<32+ chars> seshat run seshat/server.ts      (ECHO_SESHAT_PORT, default 8001)

import { DEFAULT_PROVIDER_ID, getProviderId, getReasoningLevel, publicProviderList, type PublicProvider } from './providers.ts';
import { thresholdCharsFor } from './digest.ts';

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

// Express's spelling of the JSON type, so a forwarded answer's headers match server.js's own.
// x-echo-mode: server.js refuses an answer made in another mode than its own.
const headers: Record<string, string> = { 'x-served-by': 'seshat', 'x-echo-mode': ECHO_MODE, 'content-type': 'application/json; charset=utf-8' };

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
  },
  fetch() {
    return sendError('NOT_FOUND', 'Not found.', '', 404);
  },
});
console.log(`Echo's Seshat service on ${server.url} (mode ${ECHO_MODE})`);

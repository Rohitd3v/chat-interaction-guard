/**
 * Next.js App Router route handler for inbound webhooks.
 *
 * Wires `guard.resolveIntent` to `app/api/webhooks/[channel]/route.ts`
 * **without depending on Next.js**. App Router handlers are standard Web
 * `Request` → `Response` functions, and those are described structurally —
 * only the members actually touched are required — so this module stays free
 * of `next/server` imports and the package keeps its zero-dependency
 * guarantee. It runs unchanged on the Node.js and Edge runtimes.
 *
 * Three things this gets right that a hand-rolled route usually does not:
 *
 *  1. **Ack before dispatch.** WhatsApp expects a 200 within 20 seconds and
 *     Twilio retries aggressively. The ack `Response` is returned first and
 *     the intent is classified afterwards, in the background. On serverless
 *     platforms pass `waitUntil` from `next/server` (Next.js 15+) so the
 *     runtime keeps the process alive until dispatch completes — without it,
 *     the instance can be frozen the moment the ack is sent and the intent
 *     may never run.
 *  2. **Nothing user-controlled can 500 the route.** Malformed JSON, throwing
 *     extractors, failing auth hooks, and store outages all degrade into
 *     `onError`; the POST route itself always answers 200 (or 403 when the
 *     caller's `verify` hook rejects the request).
 *  3. **The Meta GET handshake is built in.** Meta verifies a webhook URL by
 *     GET-ting `hub.mode`, `hub.verify_token` and `hub.challenge` before ever
 *     sending traffic. Configure `verifyToken` and the exported GET handler
 *     performs the echo; misconfigured handshakes get a 403, and a route
 *     without `verifyToken` answers GET with 405.
 *
 * The engine owns no session store, so `session()` is a caller-supplied
 * lookup. Persist exactly the `InteractionSession` shape alongside your draft
 * data — the `commit`, `duplicate`-suppression and `stale`-retry semantics are
 * identical to the Express/Fastify middleware in §6.9.
 */
import {
  createInteractionHandler,
  type InteractionMiddlewareOptions,
} from './middleware.js';

/**
 * The members this route touches on a Next.js request. App Router handlers
 * receive a Web `Request` (or `NextRequest`), and both satisfy this shape.
 */
export interface NextLikeRequest {
  readonly url: string;
  readonly headers: { readonly get: (name: string) => string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface NextWebhookRouteOptions extends InteractionMiddlewareOptions {
  /**
   * Parse the request body. Defaults to `defaultParseBody`: JSON for most
   * requests, flat urlencoded fields for `application/x-www-form-urlencoded`
   * (Twilio posts that way). Override it for shapes like Slack's
   * `payload=<json string>` form field.
   */
  readonly parseBody?: ((request: NextLikeRequest) => Promise<unknown>) | undefined;

  /**
   * Keep background work alive on serverless platforms. Pass `waitUntil` from
   * `next/server` (Next.js 15+) — it also exists as a global on the Edge
   * runtime. Without it on Vercel, the instance may be frozen as soon as the
   * ack is returned and the intent may never dispatch. Unnecessary on
   * long-running Node hosts.
   */
  readonly waitUntil?: ((promise: Promise<unknown>) => void) | undefined;

  /**
   * Reject the request with 403 when it returns false. Use it for platform
   * auth checks — Telegram's `X-Telegram-Bot-Api-Secret-Token` header, Slack
   * request signing, Twilio signature validation. A throwing `verify` is
   * treated as a rejection, never a bypass.
   */
  readonly verify?: ((request: NextLikeRequest) => boolean | Promise<boolean>) | undefined;

  /**
   * Meta Cloud API webhook verification token. Enables the exported GET
   * handler's `hub.challenge` handshake; without it GET answers 405.
   */
  readonly verifyToken?: string | undefined;
}

/** The method handlers to spread into a route module's exports. */
export interface NextWebhookRoute {
  readonly POST: (request: NextLikeRequest) => Promise<Response>;
  readonly GET: (request: NextLikeRequest) => Promise<Response>;
}

/**
 * Parse a webhook body as JSON, or as flat urlencoded fields when the request
 * says `application/x-www-form-urlencoded` (Twilio posts that way). This is
 * the default `parseBody`.
 *
 * Slack interactive callbacks are urlencoded too, but with the whole
 * `block_actions` object JSON-encoded inside a single `payload` field. Unwrap
 * it by composing this:
 *
 *     parseBody: async (req) =>
 *       JSON.parse(String((await defaultParseBody(req) as { payload?: string }).payload)),
 */
export async function defaultParseBody(request: NextLikeRequest): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    // URLSearchParams is a global on the Node.js and Edge runtimes, so this
    // stays dependency-free. Values arrive percent-decoded; duplicate field
    // names collapse, which is fine for flat webhook forms.
    return Object.fromEntries(new URLSearchParams(await request.text()));
  }
  return request.json();
}

/**
 * Build the POST/GET method handlers for a Next.js App Router route module.
 * Spread the result — Next.js routes by exported name:
 *
 *     // app/api/webhooks/whatsapp/route.ts
 *     import { nextWebhookRoute } from 'chat-interaction-guard/next';
 *     import { extractInboundInteraction } from 'chat-interaction-guard/whatsapp';
 *
 *     export const { POST, GET } = nextWebhookRoute({ … });
 *
 * POST always answers 200 (the ack) and dispatches in the background; GET
 * performs the Meta verification handshake when `verifyToken` is configured.
 */
export function nextWebhookRoute(options: NextWebhookRouteOptions): NextWebhookRoute {
  const handle = createInteractionHandler(options);
  const {
    ackBody,
    onError,
    parseBody = defaultParseBody,
    verify,
    verifyToken,
    waitUntil,
  } = options;

  /** Report through the caller's error channel without ever rejecting. */
  const reportError = async (error: unknown): Promise<void> => {
    try {
      await onError?.(error, undefined);
    } catch {
      // After the ack there is no channel left to report into — onError is
      // caller code too, and an unhandled rejection must not take down the
      // process. Nothing else can observe this failure; that is the
      // fail-closed trade the Express wrapper makes with `next(error)`.
    }
  };

  const forbidden = (): Response => new Response('Forbidden', { status: 403 });

  /**
   * Background dispatch: parse → classify → dispatch, contained end to end.
   * The core reports its own failures (throwing `extract`, `session`,
   * `onIntent`, or `commit`) through `onError` and never rejects; this outer
   * catch holds what is still outside it — a throwing `parseBody` — and is
   * defensive against anything else.
   */
  const dispatch = (request: NextLikeRequest): Promise<void> =>
    (async () => {
      try {
        const body = await parseBody(request);
        await handle(body);
      } catch (error) {
        await reportError(error);
      }
    })();

  const POST = async (request: NextLikeRequest): Promise<Response> => {
    if (verify !== undefined) {
      let allowed = false;
      try {
        allowed = await verify(request);
      } catch (error) {
        // A failing auth check must read as a rejection, not a bypass.
        await reportError(error);
      }
      if (!allowed) return forbidden();
    }

    // Dispatch first so `waitUntil` never observes an already-settled void
    // where the promise mattered — then ack. The parse and classification
    // below run after this function returns its Response.
    const running = dispatch(request);
    waitUntil?.(running);
    return buildAckResponse(ackBody);
  };

  const GET = async (request: NextLikeRequest): Promise<Response> => {
    if (verifyToken === undefined) {
      return new Response(
        'This route has no `verifyToken` configured, so GET (Meta webhook verification) is unavailable.',
        { status: 405 },
      );
    }

    const params = new URL(request.url).searchParams;
    const mode = params.get('hub.mode');
    const token = params.get('hub.verify_token');
    const challenge = params.get('hub.challenge');

    if (mode === 'subscribe' && token === verifyToken && challenge !== null) {
      return new Response(challenge, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return forbidden();
  };

  return { POST, GET };
}

/**
 * Build the ack `Response` from `ackBody`:
 *
 * - `undefined` → a bare empty 200 (the default; Meta and Telegram only need
 *   the status code).
 * - a `string` → 200 with `text/plain` (handy for Twilio's `<Response/>`).
 * - a `Response` instance → passed through untouched, so callers fully
 *   control headers when they need to (`text/xml`, CORS, …).
 * - anything else → 200 with `application/json`.
 */
function buildAckResponse(ackBody: unknown): Response {
  if (ackBody instanceof Response) return ackBody;
  if (ackBody === undefined) return new Response(null, { status: 200 });
  if (typeof ackBody === 'string') {
    return new Response(ackBody, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(JSON.stringify(ackBody), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Framework middleware for inbound webhooks.
 *
 * Wires `guard.resolveIntent` to an HTTP route for Express and Fastify
 * **without depending on either**. The request and reply objects are described
 * structurally — only the members actually touched are required — so this
 * module stays free of `express` and `fastify` imports and the package keeps
 * its zero-dependency guarantee.
 *
 * Two things this gets right that a hand-rolled route usually does not:
 *
 *  1. **Ack before dispatch.** WhatsApp expects a 200 within 20 seconds and
 *     Twilio retries aggressively. `onIntent` may be slow (an API call, a DB
 *     write), so the acknowledgement is sent *first* and the handler runs
 *     afterwards. Work that must finish before the ack belongs in `onAck`.
 *  2. **Never 500 on hostile input.** `resolveIntent` throws only when given
 *     neither `rawId` nor `text`; everything user-controlled degrades to an
 *     `unknown` intent. The wrapper contains that throw and reports it as an
 *     `error` outcome instead of taking the route down.
 *
 * The engine owns no session store, so `session()` is a caller-supplied
 * lookup. Persist exactly the `InteractionSession` shape alongside your draft
 * data.
 */
import type { InteractionGuard } from './guard.js';
import type { InteractionIntent, InteractionSession } from './types.js';

/**
 * The normalized shape every adapter extractor produces. `extractTelegramCallback`
 * returns a bare string, so wrap it: `(body) => { const id = …; return id && { kind: 'payload', rawId: id }; }`
 */
export type InboundInteraction =
  | { readonly kind: 'payload'; readonly rawId: string }
  | { readonly kind: 'text'; readonly text: string };

export interface InteractionContext {
  /** The parsed request body the intent was derived from. */
  readonly body: unknown;
  /** The session snapshot used for classification. */
  readonly session: InteractionSession;
}

/** What the middleware did with a request. Returned for logging and tests. */
export type InteractionOutcome =
  /** Classified and dispatched to `onIntent`. */
  | {
      readonly status: 'handled';
      readonly intent: InteractionIntent;
      readonly context: InteractionContext;
    }
  /** The body carried no interaction (status ping, media, reaction, …). */
  | { readonly status: 'ignored' }
  /** `onIntent` threw, or `resolveIntent` was given an empty input. */
  | { readonly status: 'error'; readonly error: unknown };

export interface InteractionMiddlewareOptions {
  readonly guard: InteractionGuard;

  /** Normalize a parsed webhook body. Return `undefined` to ignore it. */
  readonly extract: (body: unknown) => InboundInteraction | undefined;

  /** Look up the session snapshot for this request (sync or async). */
  readonly session: (body: unknown) => InteractionSession | Promise<InteractionSession>;

  /** Called once per classified intent, after the ack has been sent. */
  readonly onIntent: (intent: InteractionIntent, context: InteractionContext) => void | Promise<void>;

  /** Called when `extract` returns `undefined`. Defaults to a no-op. */
  readonly onNoInteraction?: ((body: unknown) => void | Promise<void>) | undefined;

  /** Called when classification or dispatch throws. Defaults to a no-op. */
  readonly onError?:
    | ((error: unknown, body: unknown) => void | Promise<void>)
    | undefined;

  /**
   * Persist the handled interaction id so webhook redelivery and double-taps
   * classify as `duplicate` on the next delivery. Omit if you do not need
   * duplicate suppression.
   */
  readonly commit?:
    | ((
        session: InteractionSession,
        rawId: string,
        context: InteractionContext,
      ) => void | Promise<void>)
    | undefined;

  /** Body sent with the acknowledgement. Defaults to an empty 200. */
  readonly ackBody?: unknown;
}

/**
 * Build the framework-agnostic core: parsed body in, `InteractionOutcome` out.
 * Express and Fastify wrappers are thin shells over this.
 */
export function createInteractionHandler(
  options: InteractionMiddlewareOptions,
): (body: unknown) => Promise<InteractionOutcome> {
  const { guard, extract, session, onIntent, onNoInteraction, onError, commit } = options;

  return async function handle(body: unknown): Promise<InteractionOutcome> {
    const inbound = extract(body);
    if (inbound === undefined) {
      await onNoInteraction?.(body);
      return { status: 'ignored' };
    }

    try {
      // Inside the try: a store outage must degrade to an `error` outcome,
      // not escape as an unhandled rejection after the ack has been sent.
      const snapshot = await session(body);
      const context: InteractionContext = { body, session: snapshot };

      const intent =
        inbound.kind === 'payload'
          ? guard.resolveIntent({ rawId: inbound.rawId }, snapshot)
          : guard.resolveIntent({ text: inbound.text }, snapshot);

      // Record the id only for clicks we actually acted on. A `stale` click was
      // never executed, so remembering it would suppress a legitimate retry.
      if (inbound.kind === 'payload' && intent.kind !== 'stale') {
        await commit?.(snapshot, inbound.rawId, context);
      }

      await onIntent(intent, context);
      return { status: 'handled', intent, context };
    } catch (error) {
      await onError?.(error, body);
      return { status: 'error', error };
    }
  };
}

/** The members this middleware touches on an Express request. */
export interface ExpressLikeRequest {
  readonly body: unknown;
}

/** The members this middleware touches on an Express response. */
export interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  send(body?: unknown): unknown;
  end(): unknown;
}

export interface ExpressNext {
  (error?: unknown): void;
}

/**
 * Express handler. Acks synchronously, then dispatches.
 *
 *     app.post('/whatsapp', expressInteractionHandler({ … }));
 *
 * The returned function is `void`-returning so Express does not await it; work
 * after `res.send` is fire-and-forget by design.
 */
export function expressInteractionHandler(
  options: InteractionMiddlewareOptions,
): (req: ExpressLikeRequest, res: ExpressLikeResponse, next: ExpressNext) => void {
  const handle = createInteractionHandler(options);
  const ackBody = options.ackBody;

  return function middleware(req, res, next) {
    try {
      // Ack first, always. A slow handler must not cost us the webhook.
      const sent = res.status(200);
      (ackBody === undefined ? sent.end() : sent.send(ackBody));
    } catch (error) {
      next(error);
      return;
    }

    void handle(req.body)
      .then((outcome) => {
        if (outcome.status === 'error') {
          next(outcome.error);
        }
      })
      .catch(next);
  };
}

/** The members this middleware touches on a Fastify request. */
export interface FastifyLikeRequest {
  readonly body: unknown;
}

/** The members this middleware touches on a Fastify reply. */
export interface FastifyLikeReply {
  code(status: number): FastifyLikeReply;
  send(payload?: unknown): unknown;
}

/**
 * Fastify handler. Acks before awaiting the handler, then returns the reply
 * object so it composes with other preHandler/handler hooks.
 *
 *     fastify.post('/whatsapp', fastifyInteractionHandler({ … }));
 */
export function fastifyInteractionHandler(
  options: InteractionMiddlewareOptions,
): (request: FastifyLikeRequest, reply: FastifyLikeReply) => Promise<unknown> {
  const handle = createInteractionHandler(options);
  const ackBody = options.ackBody;

  return async function middleware(request, reply) {
    const sent = reply.code(200);
    if (ackBody === undefined) {
      sent.send();
    } else {
      sent.send(ackBody);
    }

    const outcome = await handle(request.body);
    if (outcome.status === 'error') {
      // The reply is already sent, so this must not throw a second time —
      // report through the error channel instead.
      options.onError?.(outcome.error, request.body);
    }
    return reply;
  };
}

/**
 * Adapt `extractTelegramCallback`, which returns a bare string rather than the
 * normalized shape, into an `extract` function for the middleware.
 */
export function telegramExtractor(
  extract: (callback_data: unknown) => string,
): (body: unknown) => InboundInteraction | undefined {
  return (body: unknown) => {
    if (typeof body !== 'object' || body === null) return undefined;
    const raw = (body as { callback_query?: { data?: unknown } }).callback_query?.data;
    if (raw === undefined || raw === null) return undefined;
    const id = extract(raw);
    return id.length > 0 ? { kind: 'payload', rawId: id } : undefined;
  };
}

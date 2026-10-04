import { describe, expect, it, vi } from 'vitest';
import { createInteractionGuard, pushStep } from '../src/index.js';
import { extractInboundInteraction } from '../src/whatsapp.js';
import { extractTelegramCallback } from '../src/telegram.js';
import {
  createInteractionHandler,
  expressInteractionHandler,
  fastifyInteractionHandler,
  telegramExtractor,
  type ExpressLikeRequest,
  type ExpressLikeResponse,
  type FastifyLikeReply,
  type InboundInteraction,
  type InteractionMiddlewareOptions,
} from '../src/middleware.js';

const guard = createInteractionGuard({ globalActions: ['cancel'] });

let stack = pushStep([], 'menu');
stack = pushStep(stack, 'awaiting_slot');
const session = { currentStep: 'awaiting_slot', flowVersion: 4, historyStack: stack };

const base = (
  overrides: Partial<InteractionMiddlewareOptions> = {},
): InteractionMiddlewareOptions => ({
  guard,
  extract: extractInboundInteraction,
  session: () => session,
  onIntent: () => {},
  ...overrides,
});

/** Minimal Express double recording call order. */
function expressDouble(order: string[]) {
  const res: ExpressLikeResponse = {
    status(code: number) {
      order.push(`status:${code}`);
      return res;
    },
    send(body?: unknown) {
      order.push(`send:${JSON.stringify(body)}`);
      return res;
    },
    end() {
      order.push('end');
      return res;
    },
  };
  // Mutable holder: the middleware's own view of `body` is readonly, but a test
  // double needs to populate it before handing the request over.
  const req = { body: undefined as unknown } as { body: unknown };
  return { req: req as ExpressLikeRequest, setBody: (b: unknown) => { req.body = b; }, res };
}

/** Minimal Fastify double recording call order. */
function fastifyDouble(order: string[]) {
  const reply: FastifyLikeReply = {
    code(status: number) {
      order.push(`code:${status}`);
      return reply;
    },
    send(payload?: unknown) {
      order.push(`send:${JSON.stringify(payload)}`);
      return reply;
    },
  };
  return reply;
}

describe('createInteractionHandler', () => {
  it('classifies a current click and dispatches it', async () => {
    const onIntent = vi.fn();
    const handle = createInteractionHandler(base({ onIntent }));
    const rawId = guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' });

    const outcome = await handle({
      interactive: { button_reply: { id: rawId } },
    });

    expect(outcome.status).toBe('handled');
    if (outcome.status === 'handled') {
      expect(outcome.intent.kind).toBe('current');
      expect(outcome.context.session).toBe(session);
    }
    expect(onIntent).toHaveBeenCalledOnce();
  });

  it('classifies rewind, global, stale, duplicate and unknown', async () => {
    const handle = createInteractionHandler(base());
    const kindOf = async (body: unknown) => {
      const o = await handle(body);
      return o.status === 'handled' ? o.intent.kind : o.status;
    };
    const button = (id: string) => ({ interactive: { button_reply: { id } } });

    expect(await kindOf(button(guard.encode({ version: 1, step: 'menu', action: 'lunch' })))).toBe(
      'rewind',
    );
    expect(await kindOf(button(guard.encode({ version: 4, step: 'awaiting_slot', action: 'cancel' })))).toBe(
      'global',
    );
    expect(await kindOf(button(guard.encode({ version: 9, step: 'menu', action: 'lunch' })))).toBe(
      'stale',
    );
    expect(await kindOf(button('garbage'))).toBe('unknown');
    expect(
      await kindOf({
        interactive: { list_reply: { id: guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' }) } },
      }),
    ).toBe('current');
  });

  it('ignores a body with no interaction and calls onNoInteraction', async () => {
    const onNoInteraction = vi.fn();
    const handle = createInteractionHandler(base({ onNoInteraction }));
    const outcome = await handle({ type: 'status' });
    expect(outcome).toEqual({ status: 'ignored' });
    expect(onNoInteraction).toHaveBeenCalledWith({ type: 'status' });
  });

  it('works without onNoInteraction or onError', async () => {
    const handle = createInteractionHandler(base());
    expect((await handle({ type: 'status' })).status).toBe('ignored');
  });

  it('commits the raw id so redelivery classifies as duplicate', async () => {
    const commit = vi.fn();
    let lastInteractionId: string | undefined;
    const handle = createInteractionHandler(
      base({
        commit,
        session: () => ({ ...session, lastInteractionId }),
      }),
    );
    const rawId = guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' });
    const body = { interactive: { button_reply: { id: rawId } } };

    await handle(body);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({}), rawId, expect.anything());

    lastInteractionId = rawId;
    const second = await handle(body);
    expect(second.status === 'handled' && second.intent.kind).toBe('duplicate');
  });

  it('does NOT commit a stale click, so a legitimate retry is not suppressed', async () => {
    const commit = vi.fn();
    const handle = createInteractionHandler(base({ commit }));
    await handle({
      interactive: {
        button_reply: { id: guard.encode({ version: 9, step: 'menu', action: 'lunch' }) },
      },
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not commit free-text interactions', async () => {
    const commit = vi.fn();
    const handle = createInteractionHandler(base({ commit }));
    await handle({ text: { body: 'cancel' } });
    expect(commit).not.toHaveBeenCalled();
  });

  it('contains a throwing onIntent and reports it via onError', async () => {
    const onError = vi.fn();
    const boom = new Error('handler exploded');
    const handle = createInteractionHandler(
      base({ onIntent: () => { throw boom; }, onError }),
    );
    const outcome = await handle({
      interactive: { button_reply: { id: guard.encode({ version: 4, step: 'awaiting_slot', action: 'a' }) } },
    });
    expect(outcome).toEqual({ status: 'error', error: boom });
    expect(onError).toHaveBeenCalledWith(boom, expect.anything());
  });

  it('contains a throwing commit so a store outage is not a 500', async () => {
    const onError = vi.fn();
    const handle = createInteractionHandler(
      base({ commit: () => { throw new Error('db down'); }, onError }),
    );
    const outcome = await handle({
      interactive: { button_reply: { id: guard.encode({ version: 4, step: 'awaiting_slot', action: 'a' }) } },
    });
    expect(outcome.status).toBe('error');
    expect(onError).toHaveBeenCalled();
  });

  it('reports a throwing session lookup as an error outcome', async () => {
    const onError = vi.fn();
    const handle = createInteractionHandler(
      base({ session: () => { throw new Error('no session'); }, onError }),
    );
    const outcome = await handle({ interactive: { button_reply: { id: 'v1:s:a' } } });
    expect(outcome.status).toBe('error');
    expect(onError).toHaveBeenCalled();
  });

  it('supports text interactions', async () => {
    const onIntent = vi.fn();
    const handle = createInteractionHandler(
      base({ onIntent, extract: (body): InboundInteraction | undefined => {
        const t = (body as { text?: { body?: string } })?.text?.body;
        return typeof t === 'string' ? { kind: 'text', text: t } : undefined;
      } }),
    );
    const outcome = await handle({ text: { body: 'Cancel' } });
    expect(outcome.status === 'handled' && outcome.intent.kind).toBe('global');
  });

  it('awaits an async onIntent before resolving', async () => {
    const order: string[] = [];
    const handle = createInteractionHandler(
      base({ onIntent: async () => { order.push('handler'); } }),
    );
    order.push('before');
    await handle({ interactive: { button_reply: { id: guard.encode({ version: 4, step: 'awaiting_slot', action: 'a' }) } } });
    order.push('after');
    expect(order).toEqual(['before', 'handler', 'after']);
  });
});

describe('expressInteractionHandler', () => {
  it('acks with a bare 200 before the handler runs', async () => {
    const order: string[] = [];
    const mw = expressInteractionHandler(
      base({ onIntent: async () => { order.push('handler'); } }),
    );
    const { req, setBody, res } = expressDouble(order);
    setBody({ interactive: { button_reply: { id: guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' }) } } });

    mw(req, res, () => order.push('next'));
    await vi.waitFor(() => expect(order).toContain('handler'));

    expect(order.slice(0, 2)).toEqual(['status:200', 'end']);
    expect(order.indexOf('status:200')).toBeLessThan(order.indexOf('handler'));
  });

  it('sends a custom ackBody when configured', async () => {
    const order: string[] = [];
    const mw = expressInteractionHandler(base({ ackBody: '<Response/>' }));
    const { req, setBody, res } = expressDouble(order);
    setBody({ type: 'status' });
    mw(req, res, () => {});
    await vi.waitFor(() => expect(order).toContain('send:"<Response/>"'));
  });

  it('forwards handler errors to next() without a second response', async () => {
    const order: string[] = [];
    const boom = new Error('nope');
    const mw = expressInteractionHandler(base({ onIntent: () => { throw boom; } }));
    const { req, setBody, res } = expressDouble(order);
    setBody({ interactive: { button_reply: { id: guard.encode({ version: 4, step: 'awaiting_slot', action: 'a' }) } } });

    mw(req, res, (err) => order.push(`next:${(err as Error).message}`));
    await vi.waitFor(() => expect(order).toContain('next:nope'));
    // Exactly one acknowledgement, no double-send.
    expect(order.filter((o) => o.startsWith('status:'))).toEqual(['status:200']);
  });

  it('routes an ack failure straight to next() and skips the handler', async () => {
    const order: string[] = [];
    const mw = expressInteractionHandler(base({ onIntent: () => { order.push('handler'); } }));
    const res: ExpressLikeResponse = {
      status() { throw new Error('socket gone'); },
      send() { return res; },
      end() { return res; },
    };
    mw({ body: {} } as ExpressLikeRequest, res, (e) => order.push(`next:${(e as Error).message}`));
    expect(order).toEqual(['next:socket gone']);
  });
});

describe('fastifyInteractionHandler', () => {
  it('acks with code 200 before the handler runs', async () => {
    const order: string[] = [];
    const mw = fastifyInteractionHandler(
      base({ onIntent: async () => { order.push('handler'); } }),
    );
    const reply = fastifyDouble(order);
    await mw(
      { body: { interactive: { button_reply: { id: guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' }) } } } },
      reply,
    );
    expect(order[0]).toBe('code:200');
    expect(order).toContain('handler');
  });

  it('sends a custom ackBody when configured', async () => {
    const order: string[] = [];
    const mw = fastifyInteractionHandler(base({ ackBody: '<Response/>' }));
    const reply = fastifyDouble(order);
    await mw({ body: { type: 'status' } }, reply);
    expect(order).toEqual(['code:200', 'send:"<Response/>"']);
  });

  it('returns the reply so it composes with other hooks', async () => {
    const reply = fastifyDouble([]);
    const returned = await fastifyInteractionHandler(base())({ body: { type: 'status' } }, reply);
    expect(returned).toBe(reply);
  });

  it('reports a post-ack error through onError rather than throwing', async () => {
    const onError = vi.fn();
    const mw = fastifyInteractionHandler(base({ onIntent: () => { throw new Error('late boom'); }, onError }));
    const reply = fastifyDouble([]);
    await expect(
      mw({ body: { interactive: { button_reply: { id: guard.encode({ version: 4, step: 'awaiting_slot', action: 'a' }) } } } }, reply),
    ).resolves.toBe(reply);
    expect(onError).toHaveBeenCalled();
  });
});

describe('telegramExtractor', () => {
  it('reads callback_query.data into the normalized shape', () => {
    const extract = telegramExtractor(extractTelegramCallback);
    expect(extract({ callback_query: { data: 'v1:s:a' } })).toEqual({
      kind: 'payload',
      rawId: 'v1:s:a',
    });
  });

  it('returns undefined for updates with no callback data', () => {
    const extract = telegramExtractor(extractTelegramCallback);
    expect(extract({ message: { text: 'hi' } })).toBeUndefined();
    expect(extract({ callback_query: {} })).toBeUndefined();
    expect(extract({ callback_query: { data: '' } })).toBeUndefined();
    expect(extract(null)).toBeUndefined();
    expect(extract('not an object')).toBeUndefined();
  });

  it('drives a full Telegram round-trip through the handler', async () => {
    const onIntent = vi.fn();
    const handle = createInteractionHandler(
      base({ extract: telegramExtractor(extractTelegramCallback), onIntent }),
    );
    const kbVersion = 4;
    const outcome = await handle({
      callback_query: { data: guard.encode({ version: kbVersion, step: 'awaiting_slot', action: 'lunch' }) },
    });
    expect(outcome.status === 'handled' && outcome.intent.kind).toBe('current');
    expect(onIntent).toHaveBeenCalledOnce();
  });

  it('supports asynchronous session retrieval (e.g. from database or cache)', async () => {
    const onIntent = vi.fn();
    const handle = createInteractionHandler(
      base({
        session: async () => {
          // Simulate async DB / Redis lookup
          await new Promise((resolve) => setTimeout(resolve, 5));
          return session;
        },
        onIntent,
      }),
    );
    const outcome = await handle({
      interactive: { button_reply: { id: guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' }) } },
    });
    expect(outcome.status).toBe('handled');
    if (outcome.status === 'handled') {
      expect(outcome.intent.kind).toBe('current');
    }
    expect(onIntent).toHaveBeenCalledOnce();
  });
});


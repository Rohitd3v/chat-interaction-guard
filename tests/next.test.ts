import { describe, expect, it, vi } from 'vitest';
import { createInteractionGuard, pushStep } from '../src/index.js';
import { extractInboundInteraction } from '../src/whatsapp.js';
import { extractTwilioInteraction } from '../src/twilio.js';
import { extractSlackAction } from '../src/slack.js';
import {
  defaultParseBody,
  nextWebhookRoute,
  type NextLikeRequest,
  type NextWebhookRouteOptions,
} from '../src/next.js';

const guard = createInteractionGuard({ globalActions: ['cancel'] });

let stack = pushStep([], 'menu');
stack = pushStep(stack, 'awaiting_slot');
const session = { currentStep: 'awaiting_slot', flowVersion: 4, historyStack: stack };

const base = (
  overrides: Partial<NextWebhookRouteOptions> = {},
): NextWebhookRouteOptions => ({
  guard,
  extract: extractInboundInteraction,
  session: () => session,
  onIntent: () => {},
  ...overrides,
});

const URL_ = 'https://bot.example/api/webhooks/whatsapp';

function jsonRequest(body: unknown): Request {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function formRequest(fields: Record<string, string>): Request {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

function getRequest(params: Record<string, string>): Request {
  const search = new URLSearchParams(params).toString();
  return new Request(`${URL_}?${search}`, { method: 'GET' });
}

/** A plain object standing in for a Next.js request — proves no `Request` is required. */
function plainRequest(overrides: Partial<NextLikeRequest> = {}): NextLikeRequest {
  return {
    url: `${URL_}?hub.mode=subscribe`,
    headers: { get: () => null },
    json: async () => {
      throw new Error('no body');
    },
    text: async () => '',
    ...overrides,
  };
}

/** Captures the background dispatch promise through the `waitUntil` hook. */
function waitUntilCapture() {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil: (p: Promise<unknown>) => {
      promises.push(p);
    },
    drain: () => Promise.all(promises),
  };
}

const button = (id: string) => ({ interactive: { button_reply: { id } } });

describe('nextWebhookRoute POST: dispatch & classification', () => {
  it('returns the ack while the intent handler is still pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onIntent = vi.fn();
    const { promises, waitUntil, drain } = waitUntilCapture();
    const route = nextWebhookRoute(
      base({
        onIntent,
        waitUntil,
        session: async () => {
          await gate;
          return session;
        },
      }),
    );
    const rawId = guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' });

    const response = await route.POST(jsonRequest(button(rawId)));

    // The 200 is already back even though the session lookup is parked on the
    // gate — a slow handler cannot cost us the webhook.
    expect(response.status).toBe(200);
    expect(onIntent).not.toHaveBeenCalled();

    release();
    await drain();
    expect(onIntent).toHaveBeenCalledOnce();
  });

  it('classifies a current click through the real extractor', async () => {
    const onIntent = vi.fn();
    const { waitUntil, drain } = waitUntilCapture();
    const route = nextWebhookRoute(base({ onIntent, waitUntil }));
    const rawId = guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' });

    const response = await route.POST(jsonRequest(button(rawId)));
    await drain();

    expect(response.status).toBe(200);
    expect(onIntent).toHaveBeenCalledOnce();
    const [intent] = onIntent.mock.calls[0] ?? [];
    expect(intent?.kind).toBe('current');
  });

  it('classifies rewind, global, stale and unknown intents', async () => {
    const kinds: string[] = [];
    const { waitUntil, drain } = waitUntilCapture();
    const route = nextWebhookRoute(
      base({
        waitUntil,
        onIntent: (intent) => {
          kinds.push(intent.kind);
        },
      }),
    );
    const post = async (body: unknown) => {
      await route.POST(jsonRequest(body));
      await drain();
    };

    await post(button(guard.encode({ version: 1, step: 'menu', action: 'lunch' }))); // menu in stack → rewind
    await post(button(guard.encode({ version: 4, step: 'awaiting_slot', action: 'cancel' }))); // global
    await post(button(guard.encode({ version: 9, step: 'menu', action: 'lunch' }))); // future version → stale
    await post(button('garbage')); // unparseable → unknown

    expect(kinds).toEqual(['rewind', 'global', 'stale', 'unknown']);
  });

  it('commits the handled id so a redelivery classifies as duplicate', async () => {
    let lastInteractionId: string | undefined;
    const commit = vi.fn();
    const kinds: string[] = [];
    const { waitUntil, drain } = waitUntilCapture();
    const route = nextWebhookRoute(
      base({
        commit,
        waitUntil,
        session: () => ({ ...session, lastInteractionId }),
        onIntent: (intent) => {
          kinds.push(intent.kind);
        },
      }),
    );
    const rawId = guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' });

    await route.POST(jsonRequest(button(rawId)));
    await drain();
    expect(commit).toHaveBeenCalledOnce();

    lastInteractionId = rawId;
    await route.POST(jsonRequest(button(rawId)));
    await drain();
    expect(kinds).toEqual(['current', 'duplicate']);
  });

  it('does not commit a stale click so a legitimate retry is not suppressed', async () => {
    const commit = vi.fn();
    const { waitUntil, drain } = waitUntilCapture();
    const route = nextWebhookRoute(base({ commit, waitUntil }));

    await route.POST(jsonRequest(button(guard.encode({ version: 9, step: 'menu', action: 'lunch' }))));
    await drain();

    expect(commit).not.toHaveBeenCalled();
  });

  it('ignores bodies with no interaction and calls onNoInteraction', async () => {
    const onNoInteraction = vi.fn();
    const onIntent = vi.fn();
    const { waitUntil, drain } = waitUntilCapture();
    const route = nextWebhookRoute(base({ onNoInteraction, onIntent, waitUntil }));

    const response = await route.POST(jsonRequest({ type: 'status' }));
    await drain();

    expect(response.status).toBe(200);
    expect(onNoInteraction).toHaveBeenCalledOnce();
    expect(onIntent).not.toHaveBeenCalled();
  });

  it('answers 200 and reports through onError when the body is not JSON', async () => {
    const onError = vi.fn();
    const { waitUntil, drain } = waitUntilCapture();
    const route = nextWebhookRoute(base({ onError, waitUntil }));

    const response = await route.POST(jsonRequest('<not json>'));
    await drain();

    expect(response.status).toBe(200);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('parses urlencoded bodies (Twilio) through the default parser', async () => {
    const onIntent = vi.fn();
    const { waitUntil, drain } = waitUntilCapture();
    const route = nextWebhookRoute(
      base({ onIntent, waitUntil, extract: extractTwilioInteraction }),
    );
    const rawId = guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' });

    const response = await route.POST(formRequest({ ButtonPayload: rawId, From: '+15551234567' }));
    await drain();

    expect(response.status).toBe(200);
    const [intent] = onIntent.mock.calls[0] ?? [];
    expect(intent?.kind).toBe('current');
  });

  it('contains a throwing extract as an error outcome on a 200', async () => {
    const onError = vi.fn();
    const { waitUntil, drain } = waitUntilCapture();
    const route = nextWebhookRoute(
      base({
        onError,
        waitUntil,
        extract: () => {
          throw new Error('bad extract');
        },
      }),
    );

    const response = await route.POST(jsonRequest(button('v1:s:a')));
    await drain();

    expect(response.status).toBe(200);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('contains a throwing parseBody as an error outcome on a 200', async () => {
    const onError = vi.fn();
    const { waitUntil, drain } = waitUntilCapture();
    const route = nextWebhookRoute(
      base({
        onError,
        waitUntil,
        parseBody: () => {
          throw new Error('bad parser');
        },
      }),
    );

    const response = await route.POST(jsonRequest(button('v1:s:a')));
    await drain();

    expect(response.status).toBe(200);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('swallows a throwing onError so nothing rejects after the ack', async () => {
    const { promises, waitUntil } = waitUntilCapture();
    const route = nextWebhookRoute(
      base({
        waitUntil,
        extract: () => {
          throw new Error('bad extract');
        },
        onError: () => {
          throw new Error('bad logger');
        },
      }),
    );

    await route.POST(jsonRequest(button('v1:s:a')));
    await expect(Promise.all(promises)).resolves.toEqual([undefined]);
  });

  it('swallows a throwing onError raised from a dispatch-level failure', async () => {
    const { promises, waitUntil } = waitUntilCapture();
    const route = nextWebhookRoute(
      base({
        waitUntil,
        parseBody: () => {
          throw new Error('bad parser');
        },
        onError: () => {
          throw new Error('bad logger');
        },
      }),
    );

    await route.POST(jsonRequest(button('v1:s:a')));
    await expect(Promise.all(promises)).resolves.toEqual([undefined]);
  });

  it('stays silent when a failure path has no onError', async () => {
    const { promises, waitUntil } = waitUntilCapture();
    const route = nextWebhookRoute(base({ waitUntil }));

    const response = await route.POST(jsonRequest('<not json>'));
    await Promise.all(promises);

    expect(response.status).toBe(200);
  });

  it('hands the background dispatch promise to waitUntil', async () => {
    const { promises, waitUntil } = waitUntilCapture();
    const route = nextWebhookRoute(base({ waitUntil }));

    const response = await route.POST(jsonRequest({ type: 'status' }));
    await Promise.all(promises);

    expect(response.status).toBe(200);
    expect(promises).toHaveLength(1);
  });
});

describe('nextWebhookRoute POST: ackBody', () => {
  it('sends a string ackBody as text/plain', async () => {
    const route = nextWebhookRoute(base({ ackBody: '<Response/>' }));

    const response = await route.POST(jsonRequest({ type: 'status' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('<Response/>');
  });

  it('sends an object ackBody as application/json', async () => {
    const route = nextWebhookRoute(base({ ackBody: { ok: true } }));

    const response = await route.POST(jsonRequest({ type: 'status' }));

    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.text()).toBe('{"ok":true}');
  });

  it('passes a Response ackBody through untouched', async () => {
    const custom = new Response('pong', {
      status: 200,
      headers: { 'content-type': 'text/xml' },
    });
    const route = nextWebhookRoute(base({ ackBody: custom }));

    const response = await route.POST(jsonRequest({ type: 'status' }));

    expect(response).toBe(custom);
  });
});

describe('nextWebhookRoute POST: verify', () => {
  it('rejects with 403 and skips dispatch when verify returns false', async () => {
    const onIntent = vi.fn();
    const { waitUntil, drain } = waitUntilCapture();
    const route = nextWebhookRoute(base({ onIntent, waitUntil, verify: () => false }));
    const rawId = guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' });

    const response = await route.POST(jsonRequest(button(rawId)));
    await drain();

    expect(response.status).toBe(403);
    expect(onIntent).not.toHaveBeenCalled();
  });

  it('dispatches when an async verify passes and rejects when it does not', async () => {
    const onIntent = vi.fn();
    const { waitUntil, drain } = waitUntilCapture();
    const route = nextWebhookRoute(
      base({
        onIntent,
        waitUntil,
        verify: (req) =>
          Promise.resolve(req.headers.get('x-telegram-bot-api-secret-token') === 's3cret'),
      }),
    );
    const rawId = guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' });
    const allowed = new Request(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 's3cret',
      },
      body: JSON.stringify(button(rawId)),
    });

    expect((await route.POST(allowed)).status).toBe(200);
    await drain();
    expect(onIntent).toHaveBeenCalledOnce();

    expect((await route.POST(jsonRequest(button(rawId)))).status).toBe(403);
  });

  it('treats a throwing verify as a rejection and reports it', async () => {
    const onError = vi.fn();
    const { waitUntil, drain } = waitUntilCapture();
    const route = nextWebhookRoute(
      base({
        onError,
        waitUntil,
        verify: () => {
          throw new Error('hmac unavailable');
        },
      }),
    );

    const response = await route.POST(jsonRequest({ type: 'status' }));
    await drain();

    expect(response.status).toBe(403);
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('nextWebhookRoute GET: Meta verification', () => {
  it('echoes hub.challenge on a valid verification request', async () => {
    const route = nextWebhookRoute(base({ verifyToken: 'shhh' }));

    const response = await route.GET(
      getRequest({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'shhh',
        'hub.challenge': '1158201444',
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('1158201444');
  });

  it('answers 403 on a bad handshake', async () => {
    const route = nextWebhookRoute(base({ verifyToken: 'shhh' }));
    const bad: Request[] = [
      getRequest({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': 'x' }),
      getRequest({ 'hub.mode': 'denied', 'hub.verify_token': 'shhh', 'hub.challenge': 'x' }),
      getRequest({ 'hub.mode': 'subscribe', 'hub.verify_token': 'shhh' }),
    ];

    for (const request of bad) {
      expect((await route.GET(request)).status).toBe(403);
    }
  });

  it('answers 405 for GET when no verifyToken is configured', async () => {
    const route = nextWebhookRoute(base());

    const response = await route.GET(plainRequest());

    expect(response.status).toBe(405);
  });
});

describe('defaultParseBody', () => {
  it('parses JSON bodies', async () => {
    expect(await defaultParseBody(jsonRequest({ hello: 'world' }))).toEqual({ hello: 'world' });
  });

  it('parses urlencoded bodies into flat decoded fields', async () => {
    expect(await defaultParseBody(formRequest({ ButtonPayload: 'v4:s:a', From: '+1555' }))).toEqual({
      ButtonPayload: 'v4:s:a',
      From: '+1555',
    });
  });

  it('falls back to JSON when no content-type is set', async () => {
    const request = plainRequest({ json: async () => ({ a: 1 }) });
    expect(await defaultParseBody(request)).toEqual({ a: 1 });
  });

  it('composes into the Slack payload one-liner and dispatches the click', async () => {
    const onIntent = vi.fn();
    const { waitUntil, drain } = waitUntilCapture();
    const route = nextWebhookRoute(
      base({
        onIntent,
        waitUntil,
        extract: extractSlackAction,
        parseBody: async (request) =>
          JSON.parse(String(((await defaultParseBody(request)) as { payload?: string }).payload)),
      }),
    );
    const rawId = guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' });

    const response = await route.POST(
      formRequest({
        payload: JSON.stringify({ type: 'block_actions', actions: [{ value: rawId }] }),
      }),
    );
    await drain();

    expect(response.status).toBe(200);
    const [intent] = onIntent.mock.calls[0] ?? [];
    expect(intent?.kind).toBe('current');
  });
});

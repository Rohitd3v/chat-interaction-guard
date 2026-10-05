/**
 * Documentation examples, kept honest by CI.
 *
 * Every library-facing snippet in docs/ is compiled here, so an API change
 * that invalidates the docs fails `npm run typecheck`; the recipe patterns
 * from docs/recipes.md also run as real assertions below.
 * Framework imports that are not dev dependencies here (express, fastify,
 * next/server, Bolt, redis clients) are replaced with structural stubs; every
 * call into this package is verbatim from the docs.
 */
import { describe, expect, it } from 'vitest';
import {
  createInteractionGuard,
  popStep,
  pruneDraft,
  pushStep,
  unwindHistory,
  type InteractionIntent,
  type InteractionSession,
} from '../src/index.js';
import { createWhatsAppAdapter, extractInboundInteraction } from '../src/whatsapp.js';
import { createTelegramAdapter, extractTelegramCallback, hasDangerousChars } from '../src/telegram.js';
import { createSlackAdapter, extractSlackAction } from '../src/slack.js';
import { createTwilioAdapter, extractTwilioInteraction } from '../src/twilio.js';
import {
  expressInteractionHandler,
  fastifyInteractionHandler,
  telegramExtractor,
} from '../src/middleware.js';
import { nextWebhookRoute, defaultParseBody } from '../src/next.js';

// ── docs/getting-started.md §3 — create the guard ─────────────────────────
export const guard = createInteractionGuard({
  maxPayloadLength: 256,
  globalActions: ['cancel', 'help', 'back_button'],
});

// ── docs/getting-started.md §6 — the app session type ─────────────────────
interface Session {
  currentStep: string;
  flowVersion: number;
  historyStack: readonly string[];
  lastInteractionId?: string;
  draft: Record<string, unknown>;
}

// ── docs/getting-started.md §4 — send versioned buttons ──────────────────
const whatsapp = createWhatsAppAdapter(guard);

function renderStep(session: Session) {
  switch (session.currentStep) {
    case 'home':
      return {
        type: 'interactive' as const,
        interactive: {
          type: 'button' as const,
          body: { text: 'Welcome! Pick a plan:' },
          ...whatsapp.buildButtonsAction({
            version: session.flowVersion,
            step: 'home',
            options: [
              { action: 'order', title: 'Order food' },
              { action: 'help', title: 'Help' },
            ],
          }),
        },
      };
    default:
      return null;
  }
}

// forward transition from §4
const plan = 'family';
function advanceFrom(session: Session): Session {
  return {
    ...session,
    flowVersion: session.flowVersion + 1,
    currentStep: 'awaiting_slot',
    historyStack: pushStep(session.historyStack, 'awaiting_slot'),
    draft: { ...session.draft, awaiting_plan: plan },
  };
}

// ── docs/getting-started.md §5 — classify an incoming click ──────────────
function classify(message: unknown, session: Session) {
  const inbound = extractInboundInteraction(message);
  if (!inbound) return null;

  return inbound.kind === 'payload'
    ? guard.resolveIntent({ rawId: inbound.rawId }, session)
    : guard.resolveIntent({ text: inbound.text }, session);
}

// ── docs/getting-started.md §6 — handle the six intents ──────────────────
declare function advance(session: Session, action: string): void;
declare function renderPrompt(session: Session): void;
declare function resendCurrentPrompt(session: Session): void;
declare function abortOrder(session: Session): void;
declare function sendHelp(session: Session): void;
declare function send(session: Session, text: string): void;

async function handleIntent(intent: InteractionIntent, session: Session): Promise<void> {
  switch (intent.kind) {
    case 'current':
      return advance(session, intent.action);

    case 'rewind': {
      const unwind = unwindHistory(session.historyStack, intent.targetStep);
      if (!unwind.ok) return renderPrompt(session);
      session.historyStack = unwind.stack;
      session.currentStep = intent.targetStep;
      session.flowVersion += 1;
      session.draft = pruneDraft({ draft: session.draft, unwoundSteps: intent.prunedSteps });
      return renderPrompt(session);
    }

    case 'stale':
      return resendCurrentPrompt(session);

    case 'global':
      if (intent.action === 'back_button') {
        const back = popStep(session.historyStack);
        if (back.ok) {
          session.historyStack = back.stack;
          session.currentStep = back.stack.at(-1)!;
          session.flowVersion += 1;
          session.draft = pruneDraft({ draft: session.draft, unwoundSteps: back.prunedSteps });
        }
        return renderPrompt(session);
      }
      return intent.action === 'cancel' ? abortOrder(session) : sendHelp(session);

    case 'duplicate':
      return;

    case 'unknown':
      return send(session, "🤖 I didn't understand that.");
  }
}

// rawId persistence habit from §6
function persistRawId(intent: InteractionIntent, session: Session): void {
  if ('rawId' in intent && intent.kind !== 'stale' && intent.rawId !== undefined) {
    session.lastInteractionId = intent.rawId;
  }
}

// ── docs/getting-started.md §7 — Express wiring (structural, no express) ─
declare function loadSession(body: unknown): Session;
declare function phoneOf(body: unknown): string;
declare function saveLastInteractionId(session: InteractionSession, rawId: string): void;

const app: { post(path: string, handler: unknown): void } = { post: () => {} };

app.post('/webhooks/whatsapp', expressInteractionHandler({
  guard,
  extract: extractInboundInteraction,
  session: (body) => loadSession(phoneOf(body)),
  commit: (session, rawId) => saveLastInteractionId(session, rawId),
  onIntent: (intent, { session }) => handleIntent(intent, session as Session),
  onError: (err) => console.error(err),
}));

// ── docs/platform-guides.md — Telegram ────────────────────────────────────
const tgGuard = createInteractionGuard({ maxPayloadLength: 64, globalActions: ['cancel'] });
const tg = createTelegramAdapter(tgGuard);

const kb = tg.buildKeyboard({
  version: 3,
  step: 'awaiting_slot',
  rows: [
    [{ action: 'lunch', text: 'Lunch 🍔' }, { action: 'dinner', text: 'Dinner 🍝' }],
    [{ action: 'cancel', text: 'Cancel' }],
  ],
});
void kb;
void hasDangerousChars('a&b');

declare const update: { callback_query?: { data?: string } };
declare const tgSession: Session;

function telegramInbound(): void {
  const raw = update.callback_query?.data;
  if (raw !== undefined) {
    tgSession.lastInteractionId = extractTelegramCallback(raw);
    const intent = tgGuard.resolveIntent({ rawId: raw }, tgSession);
    void intent;
  }
}

// ── docs/platform-guides.md — Slack ───────────────────────────────────────
const slack = createSlackAdapter(guard, { actionId: 'booking_cta' });

const block = slack.buildActionsBlock({
  version: 3,
  step: 'awaiting_slot',
  rows: [[{ action: 'lunch', text: 'Lunch 🍔' }, { action: 'cancel', text: 'Cancel' }]],
});
void block;

declare const slackSession: Session;

function slackInbound(body: unknown): void {
  const got = extractSlackAction(body);
  if (got?.kind === 'payload') {
    slackSession.lastInteractionId = got.rawId;
    const intent = guard.resolveIntent({ rawId: got.rawId }, slackSession);
    void intent;
  }
}

// ── docs/platform-guides.md — Twilio ──────────────────────────────────────
const tw = createTwilioAdapter(guard);
const templated = createTwilioAdapter(guard, { maxQuickReplies: 10 });

const content = tw.buildQuickReplies({
  version: 3,
  step: 'awaiting_slot',
  body: 'What would you like?',
  options: [
    { action: 'lunch', title: 'Lunch 🍔' },
    { action: 'cancel', title: 'Cancel' },
  ],
});
void content;

const picker = tw.buildListPicker({
  version: 3,
  step: 'awaiting_menu',
  body: 'Pick a destination',
  button: 'Choose',
  items: [{ action: 'sfo', item: 'SFO → NYC', description: 'Flight 1337' }],
});
void picker;

declare const twilioSession: Session;

function twilioInbound(reqBody: unknown): void {
  const got = extractTwilioInteraction(reqBody);
  if (got?.kind === 'payload') {
    twilioSession.lastInteractionId = got.rawId;
    const intent = guard.resolveIntent({ rawId: got.rawId }, twilioSession);
    void intent;
  }
}

// ── docs/platform-guides.md — Fastify wiring (structural, no fastify) ────
const fastify: { post(path: string, handler: unknown): void } = { post: () => {} };

fastify.post('/webhooks/telegram', fastifyInteractionHandler({
  guard: tgGuard,
  extract: telegramExtractor(extractTelegramCallback),
  session: () => tgSession,
  onIntent: () => {},
  ackBody: undefined,
}));

// ── docs/platform-guides.md — Next.js App Router ─────────────────────────
declare function nextLoadSession(body: unknown): Session;
declare function nextSaveLastInteractionId(session: InteractionSession, rawId: string): void;
declare function nextHandleIntent(intent: InteractionIntent, session: Session): void;

const waitUntil = (promise: Promise<unknown>): void => { void promise; };

export const { POST, GET } = nextWebhookRoute({
  guard,
  extract: extractInboundInteraction,
  session: (body) => nextLoadSession(body),
  commit: (session, rawId) => nextSaveLastInteractionId(session, rawId),
  onIntent: (intent, ctx) => nextHandleIntent(intent, ctx.session as Session),
  onError: (err) => console.error(err),
  waitUntil,
  verifyToken: 'token-from-env',
  verify: (req) => req.headers.get('x-telegram-bot-api-secret-token') === 's3cret',
});

// NextLikeRequest accepts a real Web Request; the handlers return Response.
const postCheck: (request: Request) => Promise<Response> = POST;
const getCheck: (request: Request) => Promise<Response> = GET;
void postCheck;
void getCheck;

// Slack payload one-liner for `parseBody` (platform-guides + api-reference)
const slackRoute = nextWebhookRoute({
  guard,
  extract: extractSlackAction,
  session: () => slackSession,
  onIntent: () => {},
  parseBody: async (req) =>
    JSON.parse(String(((await defaultParseBody(req)) as { payload?: string }).payload)),
});
void slackRoute;

// ── docs/recipes.md — global handlers ─────────────────────────────────────
declare function render(session: Session): void;
declare function helpText(session: Session): void;

function handleGlobal(action: string, session: Session): void {
  switch (action) {
    case 'cancel':
      session.historyStack = ['home'];
      session.currentStep = 'home';
      session.flowVersion += 1;
      session.draft = {};
      render(session);
      break;

    case 'back_button': {
      const back = popStep(session.historyStack);
      if (!back.ok) break; // stack_underflow → you're at the first step
      session.historyStack = back.stack;
      session.currentStep = back.stack.at(-1)!;
      session.flowVersion += 1;
      session.draft = pruneDraft({ draft: session.draft, unwoundSteps: back.prunedSteps });
      render(session);
      break;
    }

    default:
      helpText(session);
  }
}
void handleGlobal;

// ── docs/recipes.md — table tests ─────────────────────────────────────────
let stack: readonly string[] = pushStep([], 'home');
stack = pushStep(stack, 'awaiting_plan');
stack = pushStep(stack, 'awaiting_slot');
const recipeSession = { currentStep: 'awaiting_slot', flowVersion: 3, historyStack: stack };

describe('recipes: intent matrix', () => {
  it('rewinds to a visited step and prunes downstream steps', () => {
    const intent = guard.resolveIntent(
      { rawId: guard.encode({ version: 2, step: 'awaiting_plan', action: 'family' }) },
      recipeSession,
    );
    expect(intent).toMatchObject({
      kind: 'rewind',
      targetStep: 'awaiting_plan',
      prunedSteps: ['awaiting_slot'],
    });
  });

  it('marks a click from an unvisited step as stale', () => {
    const intent = guard.resolveIntent(
      { rawId: guard.encode({ version: 2, step: 'awaiting_payment', action: 'pay' }) },
      recipeSession,
    );
    expect(intent).toMatchObject({ kind: 'stale', reason: 'not_in_history' });
  });

  it('builds deterministic wire ids', () => {
    const wa = createWhatsAppAdapter(guard);
    expect(
      wa.buildButtonsAction({
        version: 3,
        step: 'awaiting_slot',
        options: [{ action: 'lunch', title: 'Lunch' }],
      }),
    ).toEqual({
      buttons: [{ type: 'reply', reply: { id: 'v3:awaiting_slot:lunch', title: 'Lunch' } }],
    });
  });
});

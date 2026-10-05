#!/usr/bin/env node
/**
 * Interactive demo playground for chat-interaction-guard.
 *
 * Simulates the "Immutable Canvas" problem: every prompt this fake bot has
 * ever rendered stays clickable forever. Answer the current prompt with its
 * number, or click ANY old button from the transcript with `@<number>` and
 * watch the engine classify it (current / rewind / stale / global / duplicate).
 *
 * Run: npm run playground   (or: node dist/cli.js)
 */
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  createInteractionGuard,
  popStep,
  pruneDraft,
  pushStep,
  type InteractionIntent,
} from './index.js';
import { createWhatsAppAdapter, extractInboundInteraction } from './whatsapp.js';
import { createTelegramAdapter, extractTelegramCallback } from './telegram.js';
import { createSlackAdapter, extractSlackAction } from './slack.js';
import { createTwilioAdapter, extractTwilioInteraction } from './twilio.js';
import { telegramExtractor, type InboundInteraction } from './middleware.js';
import { nextWebhookRoute } from './next.js';

// ── ANSI helpers (no dependencies) ────────────────────────────────────────
const bold = (s: string): string => `\u001b[1m${s}\u001b[0m`;
const dim = (s: string): string => `\u001b[2m${s}\u001b[0m`;
const red = (s: string): string => `\u001b[31m${s}\u001b[0m`;
const green = (s: string): string => `\u001b[32m${s}\u001b[0m`;
const yellow = (s: string): string => `\u001b[33m${s}\u001b[0m`;
const cyan = (s: string): string => `\u001b[36m${s}\u001b[0m`;

// ── A tiny demo flow ──────────────────────────────────────────────────────
interface Option {
  readonly action: string;
  readonly label: string;
}
interface StepDef {
  readonly prompt: string;
  readonly options: readonly Option[];
}

const FLOW = {
  home: {
    prompt: '🍕 Welcome to DemoBites! What would you like to do?',
    options: [{ action: 'order', label: 'Order food' }],
  },
  awaiting_plan: {
    prompt: '📦 Pick a plan:',
    options: [
      { action: 'starter', label: 'Starter box' },
      { action: 'family', label: 'Family box' },
    ],
  },
  awaiting_slot: {
    prompt: '🕒 When should we deliver?',
    options: [
      { action: 'lunch', label: 'Lunch (1 PM)' },
      { action: 'dinner', label: 'Dinner (7 PM)' },
    ],
  },
  awaiting_address: {
    prompt: '📍 Deliver where?',
    options: [
      { action: 'home_addr', label: 'Home' },
      { action: 'work_addr', label: 'Work' },
    ],
  },
  awaiting_confirm: {
    prompt: '✅ Confirm your order?',
    options: [
      { action: 'confirm_yes', label: 'Yes, place it' },
      { action: 'confirm_no', label: 'No, start over' },
    ],
  },
} satisfies Record<string, StepDef>;

type StepId = keyof typeof FLOW;

const TRANSITIONS: Record<StepId, Partial<Record<string, StepId>>> = {
  home: { order: 'awaiting_plan' },
  awaiting_plan: { starter: 'awaiting_slot', family: 'awaiting_slot' },
  awaiting_slot: { lunch: 'awaiting_address', dinner: 'awaiting_address' },
  awaiting_address: { home_addr: 'awaiting_confirm', work_addr: 'awaiting_confirm' },
  awaiting_confirm: { confirm_no: 'home' },
};

const guard = createInteractionGuard({
  globalActions: ['back_button', 'cancel', 'menu', 'help'],
});

interface DemoState {
  currentStep: string;
  flowVersion: number;
  historyStack: string[];
  lastInteractionId: string | undefined;
  draft: Record<string, unknown>;
}

const state: DemoState = {
  currentStep: 'home',
  flowVersion: 1,
  historyStack: ['home'],
  lastInteractionId: undefined,
  draft: {},
};

interface TranscriptButton {
  readonly n: number;
  readonly rawId: string;
  readonly label: string;
  readonly step: string;
  readonly version: number;
  /** Which transport rendered this button — it keeps its payload forever. */
  readonly transport: TransportId;
  /** The exact inbound webhook body that platform POSTs back on click. */
  readonly webhook: unknown;
}

/** Every button ever rendered — the immutable canvas. */
const transcript: TranscriptButton[] = [];
let buttonCounter = 0;

// ── Transports ────────────────────────────────────────────────────────────
// Each entry builds a REAL outbound payload with the real adapter, and parses
// a REAL inbound webhook body with that adapter's own extractor. Switching
// transport mid-session does not rewrite history: a button rendered on Slack
// keeps its Slack payload in the transcript forever, which is precisely the
// point — the canvas is per-render, not per-transport.

const waAdapter = createWhatsAppAdapter(guard);
const tgAdapter = createTelegramAdapter(guard);
const slackAdapter = createSlackAdapter(guard);
const twAdapter = createTwilioAdapter(guard);

/**
 * A REAL Next.js App Router route, driven through its public surface: POST
 * acks 200 first and classifies in the background (captured via `waitUntil`,
 * exactly as `next/server` would deliver the promise); GET performs the Meta
 * verification handshake. The Next handler returns the platform's own wire
 * payloads, so the WhatsApp adapter builds the buttons for it.
 */
const nextRoute = nextWebhookRoute({
  guard,
  extract: extractInboundInteraction,
  session: () => state,
  // The route core classifies; this executes the SAME demo logic the direct
  // transports run, so a Next-delivered click advances/rewinds identically.
  onIntent: (intent) => {
    if ('rawId' in intent) {
      state.lastInteractionId = intent.rawId;
    }
    printIntent(intent);
    executeIntent(intent);
  },
  waitUntil: (dispatched) => {
    void dispatched.then((outcome) => {
      if (
        typeof outcome === 'object' &&
        outcome !== null &&
        'status' in outcome &&
        outcome.status === 'error'
      ) {
        const err = (outcome as unknown as { error: unknown }).error;
        console.log(red(`   ⚠️ onError: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  },
  verifyToken: 'demo-verify-token',
});

type TransportId = 'whatsapp' | 'telegram' | 'slack' | 'twilio' | 'next';

type AdapterInbound =
  | { readonly kind: 'payload'; readonly rawId: string }
  | { readonly kind: 'text'; readonly text: string };

interface WireRender {
  /** The JSON this platform actually puts on the wire, outbound. */
  readonly payload: unknown;
  /** The webhook body that platform POSTs back when this button is clicked. */
  readonly webhookFor: (rawId: string) => unknown;
}

interface Transport {
  readonly id: TransportId;
  readonly label: string;
  /** The binding platform limit, shown so the constraint is visible. */
  readonly limit: string;
  readonly build: (options: readonly Option[], version: number, step: string) => WireRender;
  readonly extract: (body: unknown) => InboundInteraction | undefined;
  /**
   * Read the reply ids back out of a built payload by walking that platform's
   * real wire shape. Used to assert the adapter actually embedded our id —
   * independent of the code that put it there.
   */
  readonly harvestIds: (payload: unknown) => readonly string[];
  /**
   * Only the `next` transport: drive the REAL route handler's POST surface
   * (ack-first, background classification) instead of extractor→resolver.
   */
  readonly replayNext?: (request: Request) => Promise<Response>;
}

// Minimal structural readers, so each harvester walks the shape a real webhook
// would have without asserting a type we do not control.
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function stringAt(record: Record<string, unknown> | undefined, key: string): string[] {
  const v = record?.[key];
  return typeof v === 'string' ? [v] : [];
}

/**
 * Keep only the payload branch of an adapter extractor.
 *
 * Slack and Twilio extractors also surface free-text messages; the playground
 * only ever replays button clicks, so the text branch is dropped here rather
 * than duplicated in each transport entry.
 */
function payloadOnly(
  extract: (body: unknown) => AdapterInbound | undefined,
): (body: unknown) => InboundInteraction | undefined {
  return (body) => {
    const got = extract(body);
    return got?.kind === 'payload' ? { kind: 'payload', rawId: got.rawId } : undefined;
  };
}

const TRANSPORTS: Record<TransportId, Transport> = {
  whatsapp: {
    id: 'whatsapp',
    label: 'WhatsApp Cloud API',
    limit: 'max 3 buttons, title ≤ 20 chars',
    build: (options, version, step) => {
      const action = waAdapter.buildButtonsAction({
        version,
        step,
        options: options.map((o) => ({ action: o.action, title: o.label })),
      });
      return {
        payload: action,
        webhookFor: (rawId) => ({ interactive: { button_reply: { id: rawId } } }),
      };
    },
    extract: extractInboundInteraction,
    harvestIds: (payload) =>
      asArray(asRecord(payload)?.buttons).flatMap((b) => stringAt(asRecord(asRecord(b)?.reply), 'id')),
  },
  telegram: {
    id: 'telegram',
    label: 'Telegram Inline Keyboard',
    limit: 'callback_data ≤ 64 bytes, ≤ 5 buttons/row, ≤ 20 total',
    build: (options, version, step) => {
      const keyboard = tgAdapter.buildKeyboard({
        version,
        step,
        rows: [options.map((o) => ({ action: o.action, text: o.label }))],
      });
      return {
        payload: keyboard,
        webhookFor: (rawId) => ({ callback_query: { data: rawId } }),
      };
    },
    extract: telegramExtractor(extractTelegramCallback),
    harvestIds: (payload) =>
      asArray(asRecord(payload)?.inline_keyboard)
        .flatMap((row) => asArray(row))
        .flatMap((b) => stringAt(asRecord(b), 'callback_data')),
  },
  slack: {
    id: 'slack',
    label: 'Slack Block Kit',
    limit: 'value ≤ 2000 chars, ≤ 25 elements, ≤ 5/row',
    build: (options, version, step) => {
      const block = slackAdapter.buildActionsBlock({
        version,
        step,
        rows: [options.map((o) => ({ action: o.action, text: o.label }))],
      });
      return {
        payload: { blocks: [block] },
        webhookFor: (rawId) => ({
          type: 'block_actions',
          actions: [{ action_id: 'chat_interaction', value: rawId }],
        }),
      };
    },
    extract: payloadOnly(extractSlackAction),
    harvestIds: (payload) =>
      asArray(asRecord(payload)?.blocks)
        .flatMap((block) => asArray(asRecord(block)?.elements))
        .flatMap((e) => stringAt(asRecord(e), 'value')),
  },
  twilio: {
    id: 'twilio',
    label: 'Twilio Content API',
    limit: 'id ≤ 200 chars, ≤ 3 in-session buttons, ≤ 10 template',
    build: (options, version, step) => {
      const content = twAdapter.buildQuickReplies({
        version,
        step,
        body: FLOW[step as StepId]?.prompt ?? 'Pick one',
        options: options.map((o) => ({ action: o.action, title: o.label })),
      });
      return {
        payload: { 'twilio/quick-reply': content },
        webhookFor: (rawId) => ({ ButtonPayload: rawId }),
      };
    },
    extract: payloadOnly(extractTwilioInteraction),
    harvestIds: (payload) =>
      asArray(asRecord(asRecord(payload)?.['twilio/quick-reply'])?.actions).flatMap((a) =>
        stringAt(asRecord(a), 'id'),
      ),
  },
  next: {
    id: 'next',
    label: 'Next.js App Router',
    limit: 'uses the WhatsApp adapter; route acks 200 before classifying',
    // The Next handler ships WhatsApp's wire shape (its default parseBody +
    // extractor are the WhatsApp pair), so delegate to the same builder.
    build: (options, version, step) => TRANSPORTS.whatsapp.build(options, version, step),
    extract: extractInboundInteraction,
    harvestIds: (payload) =>
      asArray(asRecord(payload)?.buttons).flatMap((b) => stringAt(asRecord(asRecord(b)?.reply), 'id')),
    replayNext: (request) => nextRoute.POST(request),
  },
};

let activeTransport: TransportId = 'whatsapp';
let lastWirePayload: unknown = null;
/**
 * Async demo output (Next route replays, the Meta handshake) settles out of
 * band — the whole point of ack-first. The main loop awaits this before the
 * next prompt so the story prints in order; the ack line itself still prints
 * the moment the route responds.
 */
let pendingDisplay: Promise<void> | null = null;

function transport(): Transport {
  return TRANSPORTS[activeTransport];
}

// ── Rendering ─────────────────────────────────────────────────────────────
function draftSummary(): string {
  return Object.entries(state.draft)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(', ');
}

function renderStep(stepId: string): void {
  const step = FLOW[stepId as StepId] ?? FLOW.home;
  console.log();
  console.log(bold(`[bot] ${step.prompt}`));
  const summary = draftSummary();
  if (summary.length > 0) {
    console.log(dim(`      (order so far: ${summary})`));
  }
  const t = transport();

  // Build the REAL outbound payload through the real adapter. A platform
  // constraint violation surfaces here — before the platform would reject the
  // whole webhook with a vague error.
  let wire: WireRender;
  try {
    wire = t.build(step.options, state.flowVersion, stepId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.log(red(`      ⚠ ${t.label} cannot render this prompt: ${message}`));
    wire = { payload: null, webhookFor: (rawId) => ({ rawId }) };
  }
  lastWirePayload = wire.payload;

  const expectedIds = step.options.map((option) =>
    guard.encode({
      version: state.flowVersion,
      step: stepId,
      action: option.action,
    }),
  );

  const broken = verifyWireIds(t, wire.payload, wire.webhookFor, expectedIds);
  if (broken !== null) {
    console.log(red(`      ⚠ WIRE ID MISMATCH: ${broken}`));
  }

  console.log(dim(`      ${t.label} · ${t.limit} · wire${broken === null ? green(' ids ✓') : ''}`));
  console.log(dim(`      wire: ${JSON.stringify(wire.payload)}`));

  for (const [i, option] of step.options.entries()) {
    const rawId = expectedIds[i]!;
    buttonCounter += 1;
    transcript.push({
      n: buttonCounter,
      rawId,
      label: option.label,
      step: stepId,
      version: state.flowVersion,
      transport: t.id,
      webhook: wire.webhookFor(rawId),
    });
    console.log(`  ${bold(`[${buttonCounter}]`)} ${option.label}  ${dim(`→ ${rawId}`)}`);
  }
}

/**
 * Assert the adapter really embedded our ids, and that they survive a trip
 * through the inbound extractor unchanged.
 *
 * The ids are harvested back out of the *built payload* by walking that
 * platform's wire shape — deliberately independent of the code that put them
 * there — so this catches an adapter that silently stops embedding the id, or
 * an extractor that stops reading the field the adapter writes.
 *
 * Returns null when the round-trip holds, or a description of the break.
 */
function verifyWireIds(
  t: Transport,
  payload: unknown,
  webhookFor: (rawId: string) => unknown,
  expected: readonly string[],
): string | null {
  const harvested = t.harvestIds(payload);
  if (harvested.length !== expected.length) {
    return `payload carries ${harvested.length} id(s), expected ${expected.length}`;
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (harvested[i] !== expected[i]) {
      return `payload id #${i + 1} is ${JSON.stringify(harvested[i])}, expected ${JSON.stringify(expected[i])}`;
    }
    const inbound = t.extract(webhookFor(harvested[i]!));
    if (inbound?.kind !== 'payload' || inbound.rawId !== harvested[i]) {
      return `extractor did not return id #${i + 1} intact (got ${JSON.stringify(inbound)})`;
    }
  }
  return null;
}

/**
 * Replay a transcript click through the transport that rendered it: webhook
 * body → that adapter's extractor → guard.resolveIntent. This exercises the
 * real inbound path rather than shortcutting straight to the raw id.
 *
 * `next`-rendered buttons take the longer road on purpose: their webhook body
 * goes through the REAL route handler — POST acks 200 first, then the intent
 * is classified in the background and captured via `waitUntil`, exactly as
 * `next/server` would keep the dispatch alive on a serverless instance.
 */
function clickTranscriptButton(token: string): void {
  const button = transcript.find((b) => b.n === Number(token));
  if (button === undefined) {
    console.log(red(`no button #${token} in the transcript — try "transcript"`));
    return;
  }
  const t = TRANSPORTS[button.transport];

  if (button.transport === 'next') {
    pendingDisplay = (async () => {
      const request = new Request('https://demobites.example/api/webhooks/whatsapp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(button.webhook),
      });
      const response = await t.replayNext!(request);
      console.log(
        dim(
          `   ↩ POST ${JSON.stringify(button.webhook)} → route acked ${response.status} ${response.headers.get('content-type') ?? ''}`,
        ),
      );
      console.log(dim('     (intent classified in the background — printed below once it lands)'));
    })();
    return;
  }

  const inbound = t.extract(button.webhook);
  console.log(
    dim(
      `   ↩ replaying via ${t.label}: ${JSON.stringify(button.webhook)} → ${
        inbound === undefined ? 'no interaction' : JSON.stringify(inbound)
      }`,
    ),
  );
  if (inbound === undefined) {
    return;
  }
  handleInteraction(
    inbound.kind === 'payload' ? { rawId: inbound.rawId } : { text: inbound.text },
  );
}

// ── Intent display ────────────────────────────────────────────────────────
function describeIntent(intent: InteractionIntent): string {
  switch (intent.kind) {
    case 'current':
      return `action "${intent.action}" on ${intent.step} @ v${intent.version}`;
    case 'rewind':
      return `click from prior step ${intent.targetStep} @ v${intent.version} (prunes: ${
        intent.prunedSteps.length > 0 ? intent.prunedSteps.join(', ') : 'nothing'
      })`;
    case 'stale':
      return `${intent.reason} (step "${intent.payload.step}", v${intent.payload.version})`;
    case 'global':
      return `"${intent.action}" via ${intent.source}`;
    case 'duplicate':
      return 'already processed this exact id';
    case 'unknown':
      return intent.reason;
  }
}

function printIntent(intent: InteractionIntent): void {
  const tag = bold(cyan(intent.kind.toUpperCase().padEnd(9)));
  console.log(`\n${tag} ${describeIntent(intent)}`);
}

// ── The §6.3 handler, live ────────────────────────────────────────────────
function handleInteraction(inputArg: { rawId: string } | { text: string }): void {
  const intent = guard.resolveIntent(inputArg, state);
  // Persist the raw id so redeliveries classify as duplicates:
  if ('rawId' in intent) {
    state.lastInteractionId = intent.rawId;
  }
  printIntent(intent);
  executeIntent(intent);
}

/**
 * The execution half of §6.3, applied to an already-classified intent. Split
 * from `handleInteraction` so the Next.js transport — whose clicks are
 * classified inside the REAL route handler — can run the identical demo
 * logic from its `onIntent`.
 */
function executeIntent(intent: InteractionIntent): void {
  switch (intent.kind) {
    case 'current': {
      if (state.currentStep === 'awaiting_confirm' && intent.action === 'confirm_yes') {
        console.log(green('\n🧾 Order placed! Starting a fresh session.\n'));
        state.draft = {};
        state.currentStep = 'home';
        state.flowVersion += 1;
        state.historyStack = ['home'];
        renderStep('home');
        return;
      }
      const next = TRANSITIONS[state.currentStep as StepId]?.[intent.action];
      if (next === undefined) {
        console.log(dim('   (demo flow has no transition for this action — staying put)'));
        return;
      }
      state.draft[intent.step] = intent.action;
      state.historyStack = [...pushStep(state.historyStack, next)];
      state.currentStep = next;
      state.flowVersion += 1;
      renderStep(next);
      return;
    }

    case 'rewind': {
      const unwind = guard.unwindHistory(state.historyStack, intent.targetStep);
      if (!unwind.ok) {
        return; // unreachable: rewind implies the step is in the trail
      }
      console.log(
        yellow(
          `   ⏪ unwinding stack ${JSON.stringify(state.historyStack)} → ${JSON.stringify(unwind.stack)}`,
        ),
      );
      state.draft = pruneDraft({ draft: state.draft, unwoundSteps: intent.prunedSteps });
      console.log(
        yellow(
          `      pruned draft: ${
            intent.prunedSteps.length > 0 ? intent.prunedSteps.join(', ') : '(nothing)'
          }`,
        ),
      );
      state.historyStack = [...unwind.stack];
      state.currentStep = intent.targetStep;
      state.flowVersion += 1;
      renderStep(intent.targetStep);
      return;
    }

    case 'stale': {
      console.log(red(`   ⚠️ ${intent.reason} — that button is from an earlier moment.`));
      console.log(dim('   (real bots alert + re-send the current prompt):'));
      renderStep(state.currentStep);
      return;
    }

    case 'global': {
      switch (intent.action) {
        case 'cancel':
          console.log(yellow('   ✋ order cancelled — draft cleared, back to home'));
          state.draft = {};
          state.historyStack = ['home'];
          state.currentStep = 'home';
          state.flowVersion += 1;
          renderStep('home');
          return;
        case 'back_button': {
          const back = popStep(state.historyStack);
          if (!back.ok) {
            console.log(red('   ⚠️ stack_underflow — already at the first step'));
            return;
          }
          state.draft = pruneDraft({ draft: state.draft, unwoundSteps: back.prunedSteps });
          state.historyStack = [...back.stack];
          state.currentStep = back.stack[back.stack.length - 1]!;
          state.flowVersion += 1;
          renderStep(state.currentStep);
          return;
        }
        case 'menu':
          console.log(yellow('   🏠 back to the main menu'));
          state.draft = {};
          state.historyStack = ['home'];
          state.currentStep = 'home';
          state.flowVersion += 1;
          renderStep('home');
          return;
        case 'help':
          console.log(dim('   ℹ️ DemoBites: fresh meals, delivered. Try @1 to click an old button!'));
          return;
        default:
          console.log(dim(`   (no handler for global "${intent.action}")`));
          return;
      }
    }

    case 'duplicate': {
      console.log(dim('   🔁 suppressed — transition NOT executed twice'));
      return;
    }

    case 'unknown': {
      console.log(
        red(
          intent.reason === 'free_text'
            ? `   🤖 I didn't understand "${intent.text}"`
            : `   🤖 unknown payload (${intent.reason})`,
        ),
      );
      return;
    }
  }
}

// ── Inspection commands ───────────────────────────────────────────────────
function printTranscript(): void {
  console.log(bold('\nclickable transcript (never unmounts):'));
  if (transcript.length === 0) {
    console.log(dim('  (empty)'));
    return;
  }
  for (const b of transcript) {
    const active = b.step === state.currentStep && b.version === state.flowVersion;
    console.log(
      `  ${bold(`[@${b.n}]`)} ${dim(b.transport.padEnd(9))} ${b.label.padEnd(16)} ${dim(
        `${b.rawId}${active ? '  ← active prompt' : ''}`,
      )}`,
    );
  }
}

function printState(): void {
  console.log(bold('\nsession snapshot (what you persist):'));
  console.log(
    JSON.stringify(
      {
        currentStep: state.currentStep,
        flowVersion: state.flowVersion,
        historyStack: state.historyStack,
        lastInteractionId: state.lastInteractionId,
        draft: state.draft,
      },
      null,
      2,
    ),
  );
}

function printTransports(): void {
  console.log(bold('\ntransports:'));
  for (const t of Object.values(TRANSPORTS)) {
    const marker = t.id === activeTransport ? bold(cyan('●')) : ' ';
    console.log(`  ${marker} ${t.id.padEnd(9)} ${t.label.padEnd(24)} ${dim(t.limit)}`);
  }
}

function printWire(): void {
  console.log(bold(`\noutbound wire payload (${activeTransport}):`));
  console.log(JSON.stringify(lastWirePayload, null, 2));
}

/** Switch transport and re-render the current prompt through it. */
function setTransport(id: string): void {
  if (!(id in TRANSPORTS)) {
    console.log(red(`unknown transport "${id}" — try: ${Object.keys(TRANSPORTS).join(', ')}`));
    return;
  }
  activeTransport = id as TransportId;
  console.log(dim(`switched to ${transport().label}. Old buttons keep their original payloads.`));
  renderStep(state.currentStep);

  // Switching to Next also demos the platform's own verification step:
  // Meta GETs the webhook URL with hub.* params before any traffic flows.
  if (id === 'next') {
    pendingDisplay = (async () => {
      const url = new URL('https://demobites.example/api/webhooks/whatsapp');
      url.searchParams.set('hub.mode', 'subscribe');
      url.searchParams.set('hub.verify_token', 'demo-verify-token');
      url.searchParams.set('hub.challenge', '1158201444');
      const response = await nextRoute.GET(new Request(url));
      console.log(
        dim(`   🔐 Meta verification handshake: GET hub.challenge → ${response.status} "${await response.text()}"`),
      );
    })();
  }
}

/** Let async demo output (route replays, handshake) finish before the next prompt. */
async function settlePendingDisplay(): Promise<void> {
  if (pendingDisplay !== null) {
    const pending = pendingDisplay;
    pendingDisplay = null;
    await pending;
  }
}

function printCommands(): void {
  console.log(dim(`
  commands:
    <number>     answer the current prompt (e.g. 1)
    @<number>    click ANY old button from the transcript (e.g. @1)
    back         fresh back_button global
    cancel       fresh cancel global
    transport    list the transports
    transport X  switch transport: whatsapp | telegram | slack | twilio | next
    wire         pretty-print the last outbound payload
    transcript   list every clickable button so far
    debug        dump session state
    quit         exit`));
}

// ── Main loop ─────────────────────────────────────────────────────────────
// Use the async-iterator form: unlike rl.question(), it settles cleanly on
// EOF, so scripted/piped input (`printf ... | node dist/cli.js`) works.
async function main(): Promise<void> {
  console.log(bold('\n╔════════════════════════════════════════════════════╗'));
  console.log(bold('║   chat-interaction-guard — interactive playground  ║'));
  console.log(bold('╚════════════════════════════════════════════════════╝'));
  console.log(dim("Every button ever rendered stays clickable — that's the Immutable Canvas problem."));
  console.log(dim("Run `transport` to switch channel and see each adapter's real wire payload."));
  printTransports();
  printCommands();

  const rl = readline.createInterface({ input, output, prompt: dim('[you] > ') });
  renderStep(state.currentStep);
  rl.prompt();

  for await (const line of rl) {
    const cmd = line.trim();

    if (cmd === 'quit' || cmd === 'q' || cmd === 'exit') {
      break;
    } else if (cmd === 'transcript') {
      printTranscript();
    } else if (cmd === 'transport') {
      printTransports();
    } else if (cmd.startsWith('transport ')) {
      setTransport(cmd.slice('transport '.length).trim());
    } else if (cmd === 'wire') {
      printWire();
    } else if (cmd === 'debug') {
      printState();
    } else if (cmd === 'help' || cmd === '?' || cmd.length === 0) {
      printCommands();
    } else if (cmd === 'back' || cmd === 'cancel' || cmd === 'menu') {
      const action = cmd === 'back' ? 'back_button' : cmd;
      handleInteraction({
        rawId: guard.encode({ version: state.flowVersion, step: state.currentStep, action }),
      });
    } else if (cmd.startsWith('@')) {
      clickTranscriptButton(cmd.slice(1));
    } else {
      const step = FLOW[state.currentStep as StepId];
      const index = Number(cmd);
      if (
        step !== undefined &&
        Number.isInteger(index) &&
        index >= 1 &&
        index <= step.options.length
      ) {
        const option = step.options[index - 1]!;
        handleInteraction({
          rawId: guard.encode({
            version: state.flowVersion,
            step: state.currentStep,
            action: option.action,
          }),
        });
      } else {
        // Free text → classified by the engine (global commands vs unknown).
        handleInteraction({ text: cmd });
      }
    }

    await settlePendingDisplay();
    rl.prompt();
  }

  await settlePendingDisplay();
  rl.close();
  console.log(dim('\nbye 👋\n'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

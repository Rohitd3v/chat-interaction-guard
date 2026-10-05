# Recipes

Focused how-tos for the parts of a guarded bot that live outside the engine.

---

## Persist the session

The engine needs exactly this shape — persist it with your domain data:

```typescript
interface InteractionSession {
  currentStep: string;
  flowVersion: number;
  historyStack: readonly string[];
  lastInteractionId?: string;
}
```

```typescript
// SQL: one row per conversation
// CREATE TABLE sessions (
//   chat_id       text PRIMARY KEY,
//   current_step  text        NOT NULL,
//   flow_version  integer     NOT NULL,
//   history_stack jsonb       NOT NULL,
//   last_interaction_id text,
//   draft         jsonb       NOT NULL DEFAULT '{}'
// );

async function loadSession(chatId: string): Promise<Session> {
  const row = await db.query('SELECT * FROM sessions WHERE chat_id = $1', [chatId]);
  return row ?? { currentStep: 'home', flowVersion: 1, historyStack: ['home'], draft: {} };
}
```

Key it by the platform's conversation id (`messages[0].from` for WhatsApp,
`callback_query.from.id` for Telegram, `body.user.id` for Slack, `From` for
Twilio). See [Concepts §4](./concepts.md) for why `historyStack` is the
rewind engine's memory — never reconstruct it, always persist it.

---

## Global handlers: `cancel` vs `back_button`

```typescript
function handleGlobal(action: string, session: Session) {
  switch (action) {
    case 'cancel':
      // Reset to home at a NEW version so every old button goes stale —
      // that is what makes the reset authoritative.
      session.historyStack = ['home'];
      session.currentStep = 'home';
      session.flowVersion += 1;
      session.draft = {};
      return renderStep(session);

    case 'back_button': {
      const back = popStep(session.historyStack);
      if (!back.ok) return send(session, "You're at the first step."); // stack_underflow
      session.historyStack = back.stack;
      session.currentStep = back.stack.at(-1)!;
      session.flowVersion += 1;
      session.draft = pruneDraft({ draft: session.draft, unwoundSteps: back.prunedSteps });
      return renderStep(session);
    }

    default:
      return sendHelp(session);
  }
}
```

Two rules worth internalizing:

1. **Every mutation bumps `flowVersion`.** It is what instantly invalidates
   every older button on screen — the reset above only "sticks" because of it.
2. **`popStep` can underflow.** Handle `stack_underflow` as a message, not a
   crash — users *will* tap Back on the first screen.

---

## Duplicate suppression beyond the single slot

`lastInteractionId` collapses immediate redeliveries and double-taps. For a
longer window (platform retries can arrive minutes apart), keep a processed-id
set *in addition*:

```typescript
// store the last N ids per conversation (a Redis SET with TTL works well;
// `redis` is your client, `chatId` the platform conversation id)
async function alreadyProcessed(chatId: string, rawId: string): Promise<boolean> {
  return redis.sismember(`seen:${chatId}`, rawId) === 1;
}

// inside onIntent, before executing 'current'/'rewind'/'global':
if (intent.kind !== 'duplicate' && 'rawId' in intent && await alreadyProcessed(session, intent.rawId)) {
  return; // suppress like `duplicate`
}
```

Keep the engine's single-slot check in place regardless — it is the zero-cost
first line of defence, and `duplicate` classification stays correct even when
your window store is down (fail-closed to "process", which is safe because the
engine's versioning still prevents double-execution of state transitions that
would rewind or corrupt).

---

## Testing your bot's interaction logic

Everything is a pure function — the intent matrix is table-testable without a
single mock:

```typescript
import { expect, it } from 'vitest';
import { createInteractionGuard, pushStep } from 'chat-interaction-guard';

const guard = createInteractionGuard({ globalActions: ['cancel'] });

let stack = pushStep([], 'home');
stack = pushStep(stack, 'awaiting_plan');
stack = pushStep(stack, 'awaiting_slot');
const session = { currentStep: 'awaiting_slot', flowVersion: 3, historyStack: stack };

it('rewinds to a visited step and prunes downstream steps', () => {
  const intent = guard.resolveIntent(
    { rawId: guard.encode({ version: 2, step: 'awaiting_plan', action: 'family' }) },
    session,
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
    session,
  );
  expect(intent).toMatchObject({ kind: 'stale', reason: 'not_in_history' });
});
```

For outbound fragments, assert on the adapter's wire output — the ids are
deterministic:

```typescript
const wa = createWhatsAppAdapter(guard);
expect(wa.buildButtonsAction({ version: 3, step: 'awaiting_slot', options: [{ action: 'lunch', title: 'Lunch' }] }))
  .toEqual({ buttons: [{ type: 'reply', reply: { id: 'v3:awaiting_slot:lunch', title: 'Lunch' } }] });
```

The repo's own suite (182 tests, `npm test`) is the canonical example of this
style — `tests/middleware.test.ts` and `tests/next.test.ts` show the HTTP
layers tested with doubles, no platform credentials needed.

---

## Deployment checklist

```
┌─ per-platform ack windows (the reason every wrapper acks first) ─────────┐
│  WhatsApp Cloud API   200 within 20 s        retries on non-2xx          │
│  Telegram             fast 200               retries on non-2xx          │
│  Slack                ack() within 3 s                                   │
│  Twilio               200 fast               retries hard on non-2xx     │
└──────────────────────────────────────────────────────────────────────────┘
```

- [ ] **Ack before work.** Use the Express/Fastify wrappers or the Next.js
      route; never `await` your FSM before responding.
- [ ] **Serverless: pass `waitUntil`** from `next/server` to the Next.js
      handler, or the instance may freeze right after the ack.
- [ ] **Verification endpoints.** Meta: `verifyToken` on the Next handler or a
      GET route echoing `hub.challenge`. Telegram: check
      `X-Telegram-Bot-Api-Secret-Token`. Slack: request signing. Twilio:
      signature validation.
- [ ] **Idempotent handlers.** `commit` handles immediate redelivery; add the
      processed-id window above if your queue can replay minutes later.
- [ ] **Never log raw draft data at error level** — webhook bodies are
      user-controlled; `onError` receives them for redaction-aware logging.
- [ ] **Load-test the rewind path.** Rewinds touch more rows than forward
      transitions (stack write + draft prune). The engine itself is pure and
      sub-millisecond (`npm run bench`); the store is where the time goes.
- [ ] **Alert on `unknown` rate.** A spike usually means a codec config
      changed (delimiter, prefix) while old buttons are still live.

---

## Multi-tenant notes

- Sessions are keyed by conversation id — one guard instance serves all
  tenants; the *codec config* is per-deployment, not per-tenant. If two
  tenants need different `globalActions`, create two guards and route by
  tenant before classification.
- `globalActions` are matched by action name only — do not encode tenant
  identity into action names.
- Old buttons from tenant A replayed to webhook route B resolve to `unknown`
  (foreign ids) unless the codecs collide; distinct `versionPrefix` per tenant
  (`'a'`, `'b'`) makes that split deterministic.

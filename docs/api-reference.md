# API reference

Every public export, by subpath. Types are exact; error codes and limits are
the values enforced in source.

---

## `chat-interaction-guard` — core

### `createInteractionGuard(config?)` → `InteractionGuard`

| Config option | Type | Default | Notes |
|---|---|---|---|
| `versionPrefix` | `string` | `'v'` | Must match `[A-Za-z0-9_-]+` |
| `delimiter` | `string` | `':'` | Exactly one char, **outside** `[A-Za-z0-9_-]` |
| `maxPayloadLength` | `number` | `256` | UTF-8 **bytes**; use `64` for Telegram |
| `globalActions` | `readonly string[]` | `[]` | Match by action name before the version/step matrix, at any version |

Invalid config throws `PayloadError('invalid_config')`.

### `InteractionGuard`

| Member | Signature | Throws? |
|---|---|---|
| `encode` | `({ version, step, action }) → string` | ✅ `PayloadError` — always a programmer error |
| `decode` | `(rawId: string) → DecodeResult` | ❌ never |
| `resolveIntent` | `(input: { rawId?; text? }, session) → InteractionIntent` | Only when **neither** `rawId` nor `text` is present (`TypeError`) |
| `unwindHistory` | `(stack, targetStep) → UnwindResult` | ❌ never |
| `pruneDraft` | `({ draft, unwoundSteps }) → Record<string, unknown>` | ❌ never |
| `config` | resolved `{ versionPrefix, delimiter, maxPayloadLength, globalActions }` | — |

### `resolveIntent` decision table

Evaluated strictly top-to-bottom; first match wins.

| # | Condition | Result |
|---|---|---|
| 1 | Text input, normalized (`trim().toLowerCase()`) in `globalActions` | `global` (`source: 'text'`) |
| 2 | Text input, otherwise | `unknown` (`reason: 'free_text'`) |
| 3 | `rawId === session.lastInteractionId` | `duplicate` — checked **before** parsing |
| 4 | Id fails to decode | `unknown` (`reason`: `empty` \| `malformed` \| `invalid_version` \| `unsafe_token` \| `too_long`) |
| 5 | `action` in `globalActions` | `global` (`source: 'payload'`) |
| 6 | `version > session.flowVersion` | `stale` (`future_version`) |
| 7 | `version === session.flowVersion` ∧ `step === session.currentStep` | `current` |
| 8 | `version === session.flowVersion` ∧ different step | `stale` (`version_step_mismatch`) |
| 9 | `version < session.flowVersion` ∧ step in `historyStack` | `rewind` (`targetStep`, `prunedSteps`) |
| 10 | `version < session.flowVersion` ∧ step absent | `stale` (`not_in_history`) |

### `InteractionIntent` — the six kinds

| Kind | Fields | `rawId` committed? |
|---|---|---|
| `current` | `rawId, version, step, action` | ✅ |
| `rewind` | `rawId, version, targetStep, prunedSteps, action` | ✅ |
| `stale` | `rawId, reason, payload` | ❌ (never — a retry should succeed) |
| `global` | `action, source ('payload'\|'text'), rawId?, payload?` | ✅ when from a payload |
| `duplicate` | `rawId, payload?` | (already committed) |
| `unknown` | `reason, rawId? / text?` | ❌ (id was junk) |

### History stack helpers

| Function | Signature | Behaviour |
|---|---|---|
| `pushStep` | `(stack, step) → stack` | Appends; consecutive duplicates collapse |
| `popStep` | `(stack) → UnwindResult` | Back one step; `stack_underflow` when fewer than 2 entries |
| `unwindHistory` | `(stack, targetStep) → UnwindResult` | Truncates to the **most recent** occurrence (`lastIndexOf`); `target_not_in_history` otherwise |
| `pruneDraft` | `({ draft, unwoundSteps }) → object` | Drops keys equal to a pruned step or prefixed `step:`; shallow copy |

```typescript
type UnwindResult =
  | { ok: true;  stack: readonly string[]; prunedSteps: readonly string[] }
  | { ok: false; reason: 'target_not_in_history' | 'stack_underflow' };
```

### Codec exports

| Export | Kind | Notes |
|---|---|---|
| `encodeInteractionId` | fn | `(input, config) → string`; throws `PayloadError` |
| `decodeInteractionId` | fn | `(rawId, config) → DecodeResult`; never throws |
| `resolveCodecConfig` | fn | Applies defaults, validates; throws `PayloadError('invalid_config')` |
| `byteLength` | fn | UTF-8 byte length of a string |
| `PayloadError` | class | `code`: `invalid_config` \| `invalid_version` \| `unsafe_token` \| `too_long` |
| `DEFAULT_VERSION_PREFIX` | const | `'v'` |
| `DEFAULT_DELIMITER` | const | `':'` |
| `DEFAULT_MAX_PAYLOAD_LENGTH` | const | `256` |

```typescript
type DecodeResult =
  | { ok: true;  payload: { version: number; step: string; action: string; rawId: string } }
  | { ok: false; reason: 'empty' | 'malformed' | 'invalid_version' | 'unsafe_token' | 'too_long' };
```

### Type imports

`InteractionIntent`, `InteractionSession`, `DecodedPayload`, `DecodeResult`,
`StaleReason` (`not_in_history | future_version | version_step_mismatch`),
`UnparseableReason`, `InteractionSource`.

---

## `chat-interaction-guard/whatsapp`

### `createWhatsAppAdapter(guard)` → `WhatsAppAdapter`

| Builder | Produces | Enforced constraints |
|---|---|---|
| `buildButtonsAction({ version, step, options })` | `{ buttons: [{ type: 'reply', reply: { id, title } }] }` | 1–3 buttons; title ≤ 20 chars |
| `buildListAction({ version, step, buttonText, sections })` | `{ button, sections: [{ title?, rows: [{ id, title, description? }] }] }` | ≤ 10 rows total; button label ≤ 20; row title ≤ 24; description ≤ 72; section title ≤ 24 |

Errors: `WhatsAppError` — `empty_options`, `too_many_buttons`, `too_many_rows`,
`invalid_title`, `invalid_description`, `duplicate_action`.
Limits constant: `WHATSAPP_LIMITS`.

### `extractInboundInteraction(message)` 

`(unknown) → { kind: 'payload'; rawId } | { kind: 'text'; text } | undefined` —
reads `interactive.button_reply.id`, `interactive.list_reply.id`, or
`text.body`; `undefined` for media/reactions/status pings.

---

## `chat-interaction-guard/telegram`

### `createTelegramAdapter(guard, { followStrict? = true })` → `TelegramAdapter`

`buildKeyboard({ version, step, rows })` → `{ inline_keyboard: [[{ text, callback_data }]] }`
— ≤ 5 buttons/row, ≤ 20 total, `callback_data` ≤ 64 bytes.

With `followStrict` (default `true`), ids containing characters Telegram
silently strips (`& + space " ' < > ,`) throw `callback_data_unsafe` at build
time. Emoji in `text` is fine — only `callback_data` is constrained.

Errors: `TelegramError` — `empty_options`, `too_many_buttons`,
`callback_data_too_long`, `duplicate_action`, `callback_data_unsafe`.
Constants: `TELEGRAM_CALLBACK_DATA_LIMIT` (64),
`TELEGRAM_CALLBACK_DANGEROUS_CHARS`; helper `hasDangerousChars(value)`.

### `extractTelegramCallback(callback_data)` 

`(unknown) → string` — returns `callback_data` unchanged; throws `TypeError`
on non-strings (programmer error). Wrap with `telegramExtractor` for HTTP
middleware.

---

## `chat-interaction-guard/slack`

### `createSlackAdapter(guard, { actionId? = 'chat_interaction' })` → `SlackAdapter`

`buildActionsBlock({ version, step, rows, blockId? = 'chat-interaction' })` →
`{ type: 'actions', block_id, elements: [{ type: 'button', text: { type: 'plain_text', text }, value, action_id }] }`

`rows` mirrors the Telegram API for grouping; Slack flattens inline (render
order preserved). Constraints: ≤ 25 elements/block, ≤ 5 per row, text ≤ 75,
`value` ≤ 2000, `action_id`/`block_id` ≤ 255.

Errors: `SlackError` — `empty_options`, `too_many_elements`, `invalid_text`,
`value_too_long`, `duplicate_action`, `invalid_action_id`.
Constants: `SLACK_LIMITS`, `DEFAULT_SLACK_ACTION_ID`.

### `extractSlackAction(payload)`

`(unknown) → { kind: 'payload'; rawId; actionId? } | { kind: 'text'; text } | undefined`
— reads `actions[].value` (`view_submission` payloads return `undefined`).

---

## `chat-interaction-guard/twilio`

### `createTwilioAdapter(guard, { maxQuickReplies? = 3 })` → `TwilioAdapter`

| Builder | Produces | Notes |
|---|---|---|
| `buildQuickReplies({ version, step, body, options })` | `{ body, actions: [{ type: 'QUICK_REPLY', title, id }] }` | 3 in-session (default), `10` for templates via `maxQuickReplies`; title ≤ 20; body ≤ 1024 |
| `buildListPicker({ version, step, body, button, items })` | `{ body, button, items: [{ id, item, description }] }` | Flat — no sections; ≤ 10 items; item ≤ 24; **description required**, ≤ 72; picker button ≤ 24; session-only (never for business-initiated templates) |

Errors: `TwilioError` — `empty_options`, `too_many_buttons`, `too_many_items`,
`invalid_body`, `invalid_title`, `invalid_description`, `duplicate_action`,
`id_too_long` (the one ceiling that guards you at default codec config, since
200 < 256).
Limits constant: `TWILIO_LIMITS`.

### `extractTwilioInteraction(body)`

`(unknown) → { kind: 'payload'; rawId } | { kind: 'text'; text } | undefined`
— reads `ButtonPayload` (quick reply), `ListItemSelected.id` (list picker), or
`Body` (text). Twilio posts form-urlencoded; the Next.js handler parses that
by default.

---

## `chat-interaction-guard/middleware`

Framework-free by structural typing — no `express`/`fastify` imports.

### `createInteractionHandler(options)` → `(body: unknown) → Promise<InteractionOutcome>`

The framework-agnostic core. Options:

| Option | Required | Notes |
|---|---|---|
| `guard` | ✅ | |
| `extract` | ✅ | `(body) → InboundInteraction \| undefined`; `undefined` ⇒ ignored |
| `session` | ✅ | `(body) → InteractionSession \| Promise<…>` |
| `onIntent` | ✅ | `(intent, { body, session }) → void \| Promise<…>` |
| `commit` | — | `(session, rawId, context)`; **skipped for `stale` and text** |
| `onNoInteraction` | — | Default no-op |
| `onError` | — | Receives `(error, body)`; default no-op |
| `ackBody` | — | Used by the HTTP wrappers below |

```typescript
type InteractionOutcome =
  | { status: 'handled'; intent: InteractionIntent; context: InteractionContext }
  | { status: 'ignored' }
  | { status: 'error'; error: unknown };
```

### HTTP wrappers

| Wrapper | Signature | Behaviour |
|---|---|---|
| `expressInteractionHandler` | `(options) → (req, res, next) → void` | Acks `200` (+`ackBody`) **synchronously**, then dispatches; handler errors go to `next(error)` |
| `fastifyInteractionHandler` | `(options) → async (request, reply) → reply` | Acks before awaiting; returns `reply` to compose with hooks; post-ack errors go to `onError` |
| `telegramExtractor` | `(extract) → extractFn` | Adapts `extractTelegramCallback`'s bare-string return |

---

## `chat-interaction-guard/next`

Next.js App Router route handlers as standard Web `Request` → `Response` — no
`next/server` import; Node & Edge runtimes.

### `nextWebhookRoute(options)` → `{ POST, GET }`

Extends the middleware options with:

| Option | Default | Notes |
|---|---|---|
| `parseBody` | `defaultParseBody` | JSON, or flat urlencoded fields for `application/x-www-form-urlencoded` (Twilio) |
| `waitUntil` | — | Pass `waitUntil` from `next/server` on serverless so background dispatch survives the ack |
| `verify` | — | `(request) → boolean \| Promise<boolean>`; `403` when false; a **throw is a rejection** |
| `verifyToken` | — | Enables the GET Meta handshake; without it GET answers `405` |

`POST`: optional `verify` → background dispatch (parse → core) → ack `200`
from `ackBody` (string ⇒ `text/plain`, object ⇒ `application/json`, `Response`
⇒ passthrough, `undefined` ⇒ empty). Nothing user-controlled can 500 it.

`GET`: `hub.mode=subscribe` + `hub.verify_token` match + `hub.challenge`
present ⇒ echo the challenge as `text/plain 200`; otherwise `403`.

### `defaultParseBody(request)` → `Promise<unknown>`

The default `parseBody`, exported for composition (Slack's
`payload=<json string>` one-liner in [Platform guides](./platform-guides.md)).

---

## CLI

`npx chat-interaction-guard` (or `npm run playground` in the repo) — the
interactive simulator. Commands: `transport` (list), `transport
whatsapp|telegram|slack|twilio|next`, `wire`, `transcript`, `debug`, `quit`.
Answer the current prompt with `<number>`; click any old button with
`@<number>`. The `next` transport drives the real App Router handler: its
prompts reuse the WhatsApp wire shape, switching to it performs the Meta GET
verification handshake, and clicks on Next-rendered buttons POST through the
real route (ack 200 → background classification → `waitUntil`).

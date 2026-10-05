# chat-interaction-guard — Documentation

> A lightweight, zero-dependency engine for versioned interactions, safe stale-button rewinds, and back-navigation in conversational bots (WhatsApp, Telegram, Slack, Twilio).

Every button a chat bot sends stays clickable **forever** — chat UIs never
unmount. This library makes every old click land somewhere safe: it classifies
each incoming interaction as `current`, `rewind`, `stale`, `global`,
`duplicate`, or `unknown`, so your FSM only ever executes what is still valid.

```
┌──────────────────────────── package map ────────────────────────────┐
│                                                                     │
│  chat-interaction-guard              core: codec + intents + stack  │
│  chat-interaction-guard/whatsapp     Meta Cloud API adapter         │
│  chat-interaction-guard/telegram     Inline Keyboard adapter        │
│  chat-interaction-guard/slack        Block Kit adapter              │
│  chat-interaction-guard/twilio       Content API adapter            │
│  chat-interaction-guard/middleware   Express / Fastify handlers     │
│  chat-interaction-guard/next         Next.js App Router route       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Where to go

| I want to… | Read |
|---|---|
| Build my first guarded bot, end to end | [Getting started](./getting-started.md) |
| Understand *why* old buttons break bots, and how the engine decides | [Concepts](./concepts.md) |
| Look up a function, option, limit, or error code | [API reference](./api-reference.md) |
| Wire a specific platform (WhatsApp / Telegram / Slack / Twilio / Express / Fastify / Next.js) | [Platform guides](./platform-guides.md) |
| Persist sessions, test my bot, go to production | [Recipes](./recipes.md) |

## Reading order

1. **[Getting started](./getting-started.md)** — a working food-ordering bot in
   ~80 lines. Skim it even if you only want the reference; it establishes the
   vocabulary (`step`, `action`, `flowVersion`, `historyStack`) used everywhere
   else.
2. **[Concepts](./concepts.md)** — the intent classification flow, the history
   stack invariants, and duplicate suppression. This is the mental model that
   makes the API surface obvious instead of arbitrary.
3. Jump to the **[platform guide](./platform-guides.md)** for your transport,
   and keep the **[API reference](./api-reference.md)** open in another tab.

## Try it in 60 seconds

```bash
npm install chat-interaction-guard
npx chat-interaction-guard
```

The playground is a fake food-ordering bot where every button ever rendered
stays clickable. Click an old one with `@<number>` and watch the engine
classify it live — across all four platform transports plus the Next.js
route handler (`transport whatsapp|telegram|slack|twilio|next`).

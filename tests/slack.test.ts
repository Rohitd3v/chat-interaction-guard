import { describe, expect, it } from 'vitest';
import { createInteractionGuard, pushStep } from '../src/index.js';
import {
  createSlackAdapter,
  DEFAULT_SLACK_ACTION_ID,
  extractSlackAction,
  SLACK_LIMITS,
  SlackError,
} from '../src/slack.js';

const guard = createInteractionGuard({ globalActions: ['cancel'] });
const slack = createSlackAdapter(guard);

describe('buildActionsBlock', () => {
  it('builds an actions block with versioned button values', () => {
    const block = slack.buildActionsBlock({
      version: 4,
      step: 'awaiting_slot',
      rows: [
        [{ action: 'lunch', text: 'Lunch 🍔' }, { action: 'dinner', text: 'Dinner 🍝' }],
        [{ action: 'cancel', text: 'Cancel' }],
      ],
    });
    expect(block).toEqual({
      type: 'actions',
      block_id: 'chat-interaction',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Lunch 🍔' },
          value: 'v4:awaiting_slot:lunch',
          action_id: DEFAULT_SLACK_ACTION_ID,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Dinner 🍝' },
          value: 'v4:awaiting_slot:dinner',
          action_id: DEFAULT_SLACK_ACTION_ID,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel' },
          value: 'v4:awaiting_slot:cancel',
          action_id: DEFAULT_SLACK_ACTION_ID,
        },
      ],
    });
  });

  it('flattens rows in order — Slack has no nested row concept', () => {
    const block = slack.buildActionsBlock({
      version: 1,
      step: 's',
      rows: [[{ action: 'a', text: 'A' }], [{ action: 'b', text: 'B' }]],
    });
    expect(block.elements.map((e) => e.value)).toEqual(['v1:s:a', 'v1:s:b']);
  });

  it('honours a custom actionId and per-button overrides', () => {
    const custom = createSlackAdapter(guard, { actionId: 'booking_cta' });
    const block = custom.buildActionsBlock({
      version: 1,
      step: 's',
      rows: [[{ action: 'a', text: 'A' }, { action: 'b', text: 'B', actionId: 'override' }]],
    });
    expect(block.elements.map((e) => e.action_id)).toEqual(['booking_cta', 'override']);
  });

  it('rejects an over-long actionId at adapter construction', () => {
    expect(() => createSlackAdapter(guard, { actionId: 'x'.repeat(256) })).toThrowError(SlackError);
  });

  it('rejects button text past the 75-character Slack limit', () => {
    expect(() =>
      slack.buildActionsBlock({
        version: 1,
        step: 's',
        rows: [[{ action: 'a', text: 'x'.repeat(76) }]],
      }),
    ).toThrowError(/exceeding the Slack limit of 75/);
  });

  it('rejects an empty actionId', () => {
    expect(() => createSlackAdapter(guard, { actionId: '' })).toThrowError(
      /actionId must be a non-empty string/,
    );
    // per-button override takes the same path
    expect(() =>
      slack.buildActionsBlock({
        version: 1,
        step: 's',
        rows: [[{ action: 'a', text: 'A', actionId: '' }]],
      }),
    ).toThrowError(/actionId must be a non-empty string/);
  });

  it('rejects an empty blockId', () => {
    expect(() =>
      slack.buildActionsBlock({
        version: 1,
        step: 's',
        rows: [[{ action: 'a', text: 'A' }]],
        blockId: '',
      }),
    ).toThrowError(/blockId must be a non-empty string/);
  });

  it('rejects an over-long blockId', () => {
    expect(() =>
      slack.buildActionsBlock({
        version: 1,
        step: 's',
        rows: [[{ action: 'a', text: 'A' }]],
        blockId: 'b'.repeat(256),
      }),
    ).toThrowError(/blockId is 256 characters/);
  });

  it('caps button value at the 2000-character Slack limit', () => {
    // Under the default codec (maxPayloadLength 256) an over-long action is
    // rejected before reaching the adapter. The reachable path is a caller who
    // raises maxPayloadLength to exploit Slack's roomier headroom — precisely
    // the case where the adapter's own ceiling has to hold the line.
    const roomy = createSlackAdapter(createInteractionGuard({ maxPayloadLength: 2048 }));
    expect(() =>
      roomy.buildActionsBlock({
        version: 1,
        step: 's',
        rows: [[{ action: 'a'.repeat(2001), text: 'Overflow' }]],
      }),
    ).toThrowError(/Button value is \d+ characters, exceeding Slack's 2000-character limit/);
  });

  it('accepts a value at exactly the 2000-character limit', () => {
    const roomy = createSlackAdapter(createInteractionGuard({ maxPayloadLength: 2048 }));
    // 'v1:s:' prefix is 5 chars, so 1995 a's lands exactly on 2000.
    const block = roomy.buildActionsBlock({
      version: 1,
      step: 's',
      rows: [[{ action: 'a'.repeat(1995), text: 'Edge' }]],
    });
    expect([...block.elements[0]!.value].length).toBe(2000);
  });

  it('rejects duplicate actions across rows', () => {
    expect(() =>
      slack.buildActionsBlock({
        version: 1,
        step: 's',
        rows: [[{ action: 'a', text: 'A' }], [{ action: 'a', text: 'A2' }]],
      }),
    ).toThrowError(/Duplicate action "a"/);
  });

  it('rejects more than 5 buttons in a single row', () => {
    expect(() =>
      slack.buildActionsBlock({
        version: 1,
        step: 's',
        rows: [Array.from({ length: 6 }, (_, i) => ({ action: `r${i}`, text: String(i) }))],
      }),
    ).toThrowError(/at most 5 buttons before wrapping/);
  });

  it('rejects more than 25 elements across all rows', () => {
    const rows = Array.from({ length: 6 }, (_, r) =>
      Array.from({ length: 5 }, (_, i) => ({ action: `r${r}_${i}`, text: String(i) })),
    );
    expect(rows.flat()).toHaveLength(30);
    expect(() => slack.buildActionsBlock({ version: 1, step: 's', rows })).toThrowError(
      /at most 25 elements in one actions block, got 30/,
    );
  });

  it('accepts exactly 25 elements', () => {
    const rows = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, (_, i) => ({ action: `r${r}_${i}`, text: String(i) })),
    );
    expect(slack.buildActionsBlock({ version: 1, step: 's', rows }).elements).toHaveLength(25);
  });

  it('rejects empty rows and empty blocks', () => {
    expect(() => slack.buildActionsBlock({ version: 1, step: 's', rows: [] })).toThrowError(
      /At least one button row is required/,
    );
    expect(() =>
      slack.buildActionsBlock({ version: 1, step: 's', rows: [[], [{ action: 'a', text: 'A' }]] }),
    ).toThrowError(/Every button row must contain at least one button/);
  });

  it('propagates the codec unsafe_token error for unsafe step/action', () => {
    for (const action of ['a&b', 'a b', 'a:b']) {
      expect(() =>
        slack.buildActionsBlock({ version: 1, step: 's', rows: [[{ action, text: 'Bad' }]] }),
      ).toThrowError(/must be a non-empty string matching/);
    }
  });

  it('rejects empty button text', () => {
    expect(() =>
      slack.buildActionsBlock({ version: 1, step: 's', rows: [[{ action: 'a', text: '' }]] }),
    ).toThrowError(SlackError);
  });

  it('exports limits that match the enforced values', () => {
    expect(SLACK_LIMITS.maxElementsPerBlock).toBe(25);
    expect(SLACK_LIMITS.maxValueLength).toBe(2000);
    expect(SLACK_LIMITS.maxButtonText).toBe(75);
  });
});

describe('extractSlackAction', () => {
  it('reads value and action_id from a block_actions payload', () => {
    expect(
      extractSlackAction({
        type: 'block_actions',
        actions: [{ action_id: DEFAULT_SLACK_ACTION_ID, value: 'v4:awaiting_slot:lunch' }],
      }),
    ).toEqual({
      kind: 'payload',
      rawId: 'v4:awaiting_slot:lunch',
      actionId: DEFAULT_SLACK_ACTION_ID,
    });
  });

  it('reports actionId as undefined when Slack omits it', () => {
    expect(extractSlackAction({ actions: [{ value: 'v1:s:a' }] })).toEqual({
      kind: 'payload',
      rawId: 'v1:s:a',
      actionId: undefined,
    });
  });

  it('falls back to message text when there are no actions', () => {
    expect(extractSlackAction({ text: { type: 'plain_text', text: 'hello' } })).toEqual({
      kind: 'text',
      text: 'hello',
    });
  });

  it('returns undefined for a view_submission with no action value', () => {
    expect(extractSlackAction({ type: 'view_submission', view: { id: 'V1' } })).toBeUndefined();
    expect(extractSlackAction(null)).toBeUndefined();
    expect(extractSlackAction({ actions: [{ value: '' }] })).toBeUndefined();
  });

  it('rejects a non-string callback payload', () => {
    // Slack hands us JSON, so a non-object reaching the adapter is a bug upstream.
    expect(extractSlackAction('v1:s:a')).toBeUndefined();
  });
});

describe('round-trip through guard.resolveIntent', () => {
  it('classifies current, rewind, global and unknown callbacks', () => {
    let stack = pushStep([], 'menu');
    stack = pushStep(stack, 'awaiting_slot');
    const session = { currentStep: 'awaiting_slot', flowVersion: 4, historyStack: stack };

    const block = slack.buildActionsBlock({
      version: 4,
      step: 'awaiting_slot',
      rows: [[{ action: 'lunch', text: 'Lunch' }, { action: 'cancel', text: 'Cancel' }]],
    });

    const classify = (raw: string) => guard.resolveIntent({ rawId: raw }, session).kind;

    expect(classify(block.elements[0]!.value)).toBe('current');
    expect(classify('v1:menu:lunch')).toBe('rewind');
    expect(classify(block.elements[1]!.value)).toBe('global');
    expect(classify('garbage')).toBe('unknown');
  });
});

import { describe, expect, it } from 'vitest';
import { createInteractionGuard, pushStep } from '../src/index.js';
import {
  createTwilioAdapter,
  extractTwilioInteraction,
  TWILIO_LIMITS,
  TwilioError,
} from '../src/twilio.js';

const guard = createInteractionGuard({ globalActions: ['cancel'] });
const tw = createTwilioAdapter(guard);

describe('buildQuickReplies', () => {
  it('builds a twilio/quick-reply content body', () => {
    const content = tw.buildQuickReplies({
      version: 4,
      step: 'awaiting_slot',
      body: 'What would you like?',
      options: [
        { action: 'lunch', title: 'Lunch 🍔' },
        { action: 'dinner', title: 'Dinner 🍝' },
        { action: 'cancel', title: 'Cancel' },
      ],
    });
    expect(content).toEqual({
      body: 'What would you like?',
      actions: [
        { type: 'QUICK_REPLY', title: 'Lunch 🍔', id: 'v4:awaiting_slot:lunch' },
        { type: 'QUICK_REPLY', title: 'Dinner 🍝', id: 'v4:awaiting_slot:dinner' },
        { type: 'QUICK_REPLY', title: 'Cancel', id: 'v4:awaiting_slot:cancel' },
      ],
    });
  });

  it('caps in-session quick replies at 3 by default', () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ action: `a${i}`, title: `A${i}` }));
    expect(() =>
      tw.buildQuickReplies({ version: 1, step: 's', body: 'b', options: four }),
    ).toThrowError(/this adapter allows 3/);
  });

  it('allows up to 10 when opted into template mode', () => {
    const templated = createTwilioAdapter(guard, { maxQuickReplies: 10 });
    const ten = Array.from({ length: 10 }, (_, i) => ({ action: `a${i}`, title: `A${i}` }));
    expect(templated.buildQuickReplies({ version: 1, step: 's', body: 'b', options: ten }).actions)
      .toHaveLength(10);
    const eleven = [...ten, { action: 'a10', title: 'A10' }];
    expect(() =>
      templated.buildQuickReplies({ version: 1, step: 's', body: 'b', options: eleven }),
    ).toThrowError(/this adapter allows 10/);
  });

  it('rejects a maxQuickReplies above the hard template ceiling of 10', () => {
    expect(() => createTwilioAdapter(guard, { maxQuickReplies: 11 })).toThrowError(TwilioError);
  });

  it('accepts exactly 3 in-session quick replies', () => {
    const three = Array.from({ length: 3 }, (_, i) => ({ action: `a${i}`, title: `A${i}` }));
    expect(tw.buildQuickReplies({ version: 1, step: 's', body: 'b', options: three }).actions)
      .toHaveLength(3);
  });

  it('rejects a title past the 20-character limit', () => {
    expect(() =>
      tw.buildQuickReplies({
        version: 1,
        step: 's',
        body: 'b',
        options: [{ action: 'a', title: 'x'.repeat(21) }],
      }),
    ).toThrowError(/exceeding the Twilio button title limit of 20/);
  });

  it('rejects a body past the 1024-character limit', () => {
    expect(() =>
      tw.buildQuickReplies({
        version: 1,
        step: 's',
        body: 'x'.repeat(1025),
        options: [{ action: 'a', title: 'A' }],
      }),
    ).toThrowError(/exceeding the Twilio body limit of 1024/);
  });

  it('rejects an empty body and empty options', () => {
    expect(() =>
      tw.buildQuickReplies({ version: 1, step: 's', body: '', options: [{ action: 'a', title: 'A' }] }),
    ).toThrowError(/body must be a non-empty string/);
    expect(() =>
      tw.buildQuickReplies({ version: 1, step: 's', body: 'b', options: [] }),
    ).toThrowError(/At least one quick-reply option is required/);
  });

  it('rejects duplicate actions', () => {
    expect(() =>
      tw.buildQuickReplies({
        version: 1,
        step: 's',
        body: 'b',
        options: [
          { action: 'a', title: 'A' },
          { action: 'a', title: 'A2' },
        ],
      }),
    ).toThrowError(/Duplicate action "a"/);
  });

  it('rejects a reply id past the 200-character Twilio limit', () => {
    // Unlike the Telegram and Slack ceilings, this one fires at the *default*
    // maxPayloadLength of 256 — Twilio's 200-char id limit sits below it, so
    // the adapter is the layer that catches it.
    expect(() =>
      tw.buildQuickReplies({
        version: 1,
        step: 's',
        body: 'b',
        options: [{ action: 'a'.repeat(196), title: 'Long' }],
      }),
    ).toThrowError(/Reply id is 201 characters, exceeding Twilio's 200-character id limit/);
  });

  it('accepts a reply id at exactly 200 characters', () => {
    // 'v1:s:' is 5 characters, so a 195-character action lands exactly on 200.
    const content = tw.buildQuickReplies({
      version: 1,
      step: 's',
      body: 'b',
      options: [{ action: 'a'.repeat(195), title: 'Edge' }],
    });
    expect(content.actions[0]!.id).toHaveLength(200);
  });

  it('applies the same id ceiling to list-picker items', () => {
    expect(() =>
      tw.buildListPicker({
        version: 1,
        step: 's',
        body: 'b',
        button: 'Go',
        items: [{ action: 'a'.repeat(196), item: 'I', description: 'D' }],
      }),
    ).toThrowError(/exceeding Twilio's 200-character id limit/);
  });
});

describe('buildListPicker', () => {
  it('builds a twilio/list-picker content body', () => {
    const content = tw.buildListPicker({
      version: 4,
      step: 'awaiting_slot',
      body: 'Pick a destination',
      button: 'Choose',
      items: [
        { action: 'sfo', item: 'SFO → NYC $299', description: 'Flight 1337' },
        { action: 'oak', item: 'OAK → DEN $149', description: 'Flight 5280' },
      ],
    });
    expect(content).toEqual({
      body: 'Pick a destination',
      button: 'Choose',
      items: [
        { id: 'v4:awaiting_slot:sfo', item: 'SFO → NYC $299', description: 'Flight 1337' },
        { id: 'v4:awaiting_slot:oak', item: 'OAK → DEN $149', description: 'Flight 5280' },
      ],
    });
  });

  it('caps items at 10 and accepts exactly 10', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      action: `a${i}`,
      item: `I${i}`,
      description: `D${i}`,
    }));
    expect(tw.buildListPicker({ version: 1, step: 's', body: 'b', button: 'Go', items: ten }).items)
      .toHaveLength(10);

    const eleven = [...ten, { action: 'a10', item: 'I10', description: 'D10' }];
    expect(() =>
      tw.buildListPicker({ version: 1, step: 's', body: 'b', button: 'Go', items: eleven }),
    ).toThrowError(/at most 10 items, got 11/);
  });

  it('rejects item text past 24 and description past 72', () => {
    expect(() =>
      tw.buildListPicker({
        version: 1,
        step: 's',
        body: 'b',
        button: 'Go',
        items: [{ action: 'a', item: 'x'.repeat(25), description: 'ok' }],
      }),
    ).toThrowError(/exceeding the Twilio item limit of 24/);

    expect(() =>
      tw.buildListPicker({
        version: 1,
        step: 's',
        body: 'b',
        button: 'Go',
        items: [{ action: 'a', item: 'ok', description: 'x'.repeat(73) }],
      }),
    ).toThrowError(/exceeding the Twilio item description limit of 72/);
  });

  it('rejects an over-long picker button label', () => {
    expect(() =>
      tw.buildListPicker({
        version: 1,
        step: 's',
        body: 'b',
        button: 'x'.repeat(25),
        items: [{ action: 'a', item: 'I', description: 'D' }],
      }),
    ).toThrowError(/exceeding the Twilio button limit of 24/);
  });

  it('rejects empty items, button and body', () => {
    expect(() =>
      tw.buildListPicker({ version: 1, step: 's', body: 'b', button: 'Go', items: [] }),
    ).toThrowError(/At least one list item is required/);
    expect(() =>
      tw.buildListPicker({
        version: 1,
        step: 's',
        body: 'b',
        button: '',
        items: [{ action: 'a', item: 'I', description: 'D' }],
      }),
    ).toThrowError(/List-picker button must be a non-empty string/);
    expect(() =>
      tw.buildListPicker({
        version: 1,
        step: 's',
        body: '',
        button: 'Go',
        items: [{ action: 'a', item: 'I', description: 'D' }],
      }),
    ).toThrowError(/body must be a non-empty string/);
  });

  it('rejects duplicate item actions', () => {
    expect(() =>
      tw.buildListPicker({
        version: 1,
        step: 's',
        body: 'b',
        button: 'Go',
        items: [
          { action: 'a', item: 'I', description: 'D' },
          { action: 'a', item: 'I2', description: 'D2' },
        ],
      }),
    ).toThrowError(/Duplicate action "a"/);
  });

  it('propagates the codec unsafe_token error for unsafe actions', () => {
    for (const action of ['a&b', 'a b', 'a:b']) {
      expect(() =>
        tw.buildListPicker({
          version: 1,
          step: 's',
          body: 'b',
          button: 'Go',
          items: [{ action, item: 'I', description: 'D' }],
        }),
      ).toThrowError(/must be a non-empty string matching/);
    }
  });

  it('exports limits matching the enforced values', () => {
    expect(TWILIO_LIMITS.maxIdLength).toBe(200);
    expect(TWILIO_LIMITS.maxQuickRepliesInSession).toBe(3);
    expect(TWILIO_LIMITS.maxQuickRepliesInTemplate).toBe(10);
    expect(TWILIO_LIMITS.maxListItems).toBe(10);
    expect(TWILIO_LIMITS.maxItemDescription).toBe(72);
  });
});

describe('extractTwilioInteraction', () => {
  it('reads ButtonPayload from a quick-reply webhook', () => {
    expect(
      extractTwilioInteraction({ From: 'whatsapp:+1', ButtonPayload: 'v4:awaiting_slot:lunch' }),
    ).toEqual({ kind: 'payload', rawId: 'v4:awaiting_slot:lunch' });
  });

  it('reads ListItemSelected.id from a list-picker webhook', () => {
    expect(
      extractTwilioInteraction({ ListItemSelected: { id: 'v4:awaiting_slot:sfo', item: 'SFO' } }),
    ).toEqual({ kind: 'payload', rawId: 'v4:awaiting_slot:sfo' });
  });

  it('prefers ButtonPayload over ListItemSelected', () => {
    expect(
      extractTwilioInteraction({
        ButtonPayload: 'v1:a:b',
        ListItemSelected: { id: 'v1:c:d' },
      }),
    ).toEqual({ kind: 'payload', rawId: 'v1:a:b' });
  });

  it('falls back to Body text', () => {
    expect(extractTwilioInteraction({ Body: 'hello' })).toEqual({ kind: 'text', text: 'hello' });
  });

  it('returns undefined for non-interactive or malformed webhooks', () => {
    expect(extractTwilioInteraction({ From: 'whatsapp:+1' })).toBeUndefined();
    expect(extractTwilioInteraction({ ButtonPayload: '' })).toBeUndefined();
    expect(extractTwilioInteraction({ ListItemSelected: { id: '' } })).toBeUndefined();
    expect(extractTwilioInteraction(null)).toBeUndefined();
    expect(extractTwilioInteraction('nope')).toBeUndefined();
  });
});

describe('round-trip through guard.resolveIntent', () => {
  it('classifies current, rewind, global and stale callbacks', () => {
    let stack = pushStep([], 'menu');
    stack = pushStep(stack, 'awaiting_slot');
    const session = { currentStep: 'awaiting_slot', flowVersion: 4, historyStack: stack };

    const content = tw.buildQuickReplies({
      version: 4,
      step: 'awaiting_slot',
      body: 'Pick one',
      options: [
        { action: 'lunch', title: 'Lunch' },
        { action: 'cancel', title: 'Cancel' },
      ],
    });

    const classify = (raw: string) => guard.resolveIntent({ rawId: raw }, session).kind;

    expect(classify(content.actions[0]!.id)).toBe('current');
    expect(classify('v1:menu:lunch')).toBe('rewind');
    expect(classify(content.actions[1]!.id)).toBe('global');
    expect(classify('v9:menu:lunch')).toBe('stale');
    expect(classify('garbage')).toBe('unknown');
  });

  it('round-trips a list-picker selection through the webhook shape', () => {
    let stack = pushStep([], 'menu');
    stack = pushStep(stack, 'awaiting_slot');
    const session = { currentStep: 'awaiting_slot', flowVersion: 4, historyStack: stack };

    const content = tw.buildListPicker({
      version: 4,
      step: 'awaiting_slot',
      body: 'Pick a slot',
      button: 'Choose',
      items: [{ action: 'sfo', item: 'SFO', description: 'Flight 1337' }],
    });

    // Exactly what Twilio POSTs back on selection.
    const webhook = {
      From: 'whatsapp:+15551234567',
      Body: 'SFO',
      ListItemSelected: { id: content.items[0]!.id, item: 'SFO', description: 'Flight 1337' },
    };
    const got = extractTwilioInteraction(webhook);
    if (got?.kind !== 'payload') {
      throw new Error('expected a payload interaction');
    }
    expect(guard.resolveIntent({ rawId: got.rawId }, session).kind).toBe('current');
  });
});

import { describe, expect, it } from 'vitest';
import { createInteractionGuard } from '../src/index.js';
import {
  createTelegramAdapter,
  extractTelegramCallback,
  hasDangerousChars,
  TELEGRAM_CALLBACK_DATA_LIMIT,
  TelegramError,
} from '../src/telegram.js';

const guard = createInteractionGuard({ globalActions: ['cancel'] });
const tg = createTelegramAdapter(guard);

describe('buildKeyboard', () => {
  it('builds inline keyboard rows with callback_data', () => {
    const kb = tg.buildKeyboard({
      version: 4,
      step: 'awaiting_slot',
      rows: [
        [{ action: 'lunch', text: 'Lunch 🍔' }, { action: 'dinner', text: 'Dinner 🍝' }],
        [{ action: 'cancel', text: 'Cancel' }],
      ],
    });
    expect(kb.inline_keyboard).toEqual([
      [
        { text: 'Lunch 🍔', callback_data: 'v4:awaiting_slot:lunch' },
        { text: 'Dinner 🍝', callback_data: 'v4:awaiting_slot:dinner' },
      ],
      [{ text: 'Cancel', callback_data: 'v4:awaiting_slot:cancel' }],
    ]);
  });

  it('rejects callback_data containing chars Telegram strips (strict default)', () => {
    // Under the default ':' delimiter this guard is unreachable: the codec's
    // [A-Za-z0-9_-] token rule rejects '&', '+' and ' ' in step/action first, so
    // it is defense-in-depth. A space delimiter passes codec validation (it lies
    // outside [A-Za-z0-9_-]) and really does land in the payload.
    const spaced = createTelegramAdapter(createInteractionGuard({ delimiter: ' ' }));
    expect(() =>
      spaced.buildKeyboard({ version: 1, step: 's', rows: [[{ action: 'ok', text: 'Bad' }]] }),
    ).toThrowError(TelegramError);
    expect(() =>
      spaced.buildKeyboard({ version: 1, step: 's', rows: [[{ action: 'ok', text: 'Bad' }]] }),
    ).toThrowError(/callback_data contains a character Telegram strips/);
  });

  it('propagates the codec unsafe_token error for unsafe step/action', () => {
    for (const action of ['a&b', 'a+b', 'a b', 'a:b']) {
      expect(() =>
        tg.buildKeyboard({ version: 1, step: 's', rows: [[{ action, text: 'Bad' }]] }),
      ).toThrowError(/must be a non-empty string matching/);
    }
  });

  it('accepts `followStrict: false` dangerous chars — caller takes responsibility', () => {
    // Non-strict mode forwards the space-delimited payload verbatim instead of
    // rejecting it, leaving sanitisation to the caller.
    const loose = createTelegramAdapter(createInteractionGuard({ delimiter: ' ' }), {
      followStrict: false,
    });
    expect(loose.buildKeyboard({ version: 1, step: 's', rows: [[{ action: 'ok', text: 'OK' }]] }))
      .toMatchObject({ inline_keyboard: [[{ callback_data: 'v1 s ok' }]] });
  });

  it('caps callback_data at 64 bytes', () => {
    const longAction = 'a'.repeat(70);
    expect(() =>
      tg.buildKeyboard({ version: 1, step: 's', rows: [[{ action: longAction, text: 'Overflow' }]] }),
    ).toThrowError(/callback_data is \d+ bytes, exceeding.*64/);
  });

  it('rejects duplicate actions (across rows)', () => {
    expect(() =>
      tg.buildKeyboard({
        version: 1,
        step: 's',
        rows: [
          [{ action: 'a', text: 'A' }],
          [{ action: 'a', text: 'A2' }],
        ],
      }),
    ).toThrowError(/Duplicate action/);
  });

  it('rejects too many rows/buttons', () => {
    const rows = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, (_, i) => ({ action: `r${r}_${i}`, text: String(i) })),
    );
    expect(() =>
      tg.buildKeyboard({ version: 1, step: 's', rows }),
    ).toThrowError(/at most 20 Inline Keyboard buttons/);
  });

  it('rejects more than 5 buttons in a single row', () => {
    expect(() =>
      tg.buildKeyboard({
        version: 1,
        step: 's',
        rows: [Array.from({ length: 6 }, (_, i) => ({ action: `r${i}`, text: String(i) }))],
      }),
    ).toThrowError(/A single Telegram inline keyboard row can display at most 5 buttons/);
  });

  it('rejects empty rows and empty keyboards', () => {
    expect(() =>
      tg.buildKeyboard({ version: 1, step: 's', rows: [] }),
    ).toThrowError(/At least one button row is required/);
    expect(() =>
      tg.buildKeyboard({ version: 1, step: 's', rows: [[], [{ action: 'a', text: 'A' }]] }),
    ).toThrowError(/Every button row must contain at least one button/);
  });

  it('propagates codec errors for unsafe codecs', () => {
    expect(() =>
      tg.buildKeyboard({ version: 1, step: 'a b', rows: [[{ action: 'a', text: 'X' }]] }),
    ).toThrow();
  });
});

describe('extractTelegramCallback', () => {
  it('returns the callback_data string as-is', () => {
    expect(extractTelegramCallback('v2:awaiting_slot:lunch')).toBe('v2:awaiting_slot:lunch');
  });
  it('rejects non-string', () => {
    expect(() => extractTelegramCallback(null as unknown as string)).toThrow(TypeError);
    expect(() => extractTelegramCallback(123 as unknown as string)).toThrow(TypeError);
  });
});

describe('hasDangerousChars', () => {
  it('detects Telegram-dangerous chars', () => {
    expect(hasDangerousChars('v1:step:help_me')).toBe(false);
    expect(hasDangerousChars('v1:step:help&me')).toBe(true);
    expect(hasDangerousChars('v1:step:help me')).toBe(true);
  });
});

describe('round trip', () => {
  it('built button callback_data resolves as CURRENT on a fresh callback', () => {
    const kb = tg.buildKeyboard({
      version: 4,
      step: 'awaiting_slot',
      rows: [[{ action: 'lunch', text: 'Lunch 🍔' }]],
    });
    const callback = kb.inline_keyboard[0]![0]!.callback_data;

    const intent = guard.resolveIntent({ rawId: callback }, {
      currentStep: 'awaiting_slot',
      flowVersion: 4,
      historyStack: ['home', 'awaiting_slot'],
    });
    expect(intent).toMatchObject({ kind: 'current', action: 'lunch' });
  });

  it('callback_data from a pending step rewinds correctly when clicked later', () => {
    const kb = tg.buildKeyboard({
      version: 2,
      step: 'awaiting_plan',
      rows: [[{ action: 'starter', text: 'Starter box' }]],
    });
    const callback = kb.inline_keyboard[0]![0]!.callback_data;

    const intent = guard.resolveIntent({ rawId: callback }, {
      currentStep: 'awaiting_slot',
      flowVersion: 4,
      historyStack: ['home', 'awaiting_plan', 'awaiting_slot'],
    });
    expect(intent).toMatchObject({
      kind: 'rewind',
      targetStep: 'awaiting_plan',
      prunedSteps: ['awaiting_slot'],
    });
  });

  it('callback_data with intent "cancel" resolves as GLOBAL', () => {
    const kb = tg.buildKeyboard({
      version: 1,
      step: 's',
      rows: [[{ action: 'cancel', text: 'Cancel' }]],
    });
    const callback = kb.inline_keyboard[0]![0]!.callback_data;

    const intent = guard.resolveIntent({ rawId: callback }, {
      currentStep: 'awaiting_slot',
      flowVersion: 4,
      historyStack: ['home', 'awaiting_slot'],
    });
    expect(intent).toMatchObject({ kind: 'global', action: 'cancel' });
  });
});

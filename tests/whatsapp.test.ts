import { describe, expect, it } from 'vitest';
import { createInteractionGuard, PayloadError } from '../src/index.js';
import {
  WHATSAPP_LIMITS,
  WhatsAppError,
  createWhatsAppAdapter,
  extractInboundInteraction,
} from '../src/whatsapp.js';

const guard = createInteractionGuard({ globalActions: ['cancel'] });
const wa = createWhatsAppAdapter(guard);

describe('buildButtonsAction', () => {
  it('builds reply buttons with versioned ids', () => {
    expect(
      wa.buildButtonsAction({
        version: 4,
        step: 'awaiting_slot',
        options: [
          { action: 'lunch', title: 'Lunch (1 PM)' },
          { action: 'dinner', title: 'Dinner (7 PM)' },
        ],
      }),
    ).toEqual({
      buttons: [
        { type: 'reply', reply: { id: 'v4:awaiting_slot:lunch', title: 'Lunch (1 PM)' } },
        { type: 'reply', reply: { id: 'v4:awaiting_slot:dinner', title: 'Dinner (7 PM)' } },
      ],
    });
  });

  it('caps at 3 buttons (WhatsApp quick-reply limit)', () => {
    const four = Array.from({ length: WHATSAPP_LIMITS.maxButtons + 1 }, (_, i) => ({
      action: `opt_${i}`,
      title: `Option ${i}`,
    }));
    expect(() =>
      wa.buildButtonsAction({ version: 1, step: 's', options: four }),
    ).toThrowError(/at most 3 quick-reply buttons/);
  });

  it('rejects empty options', () => {
    expect(() => wa.buildButtonsAction({ version: 1, step: 's', options: [] })).toThrowError(
      WhatsAppError,
    );
  });

  it('rejects over-limit titles', () => {
    expect(() =>
      wa.buildButtonsAction({
        version: 1,
        step: 's',
        options: [{ action: 'a', title: 'x'.repeat(WHATSAPP_LIMITS.maxButtonTitle + 1) }],
      }),
    ).toThrowError(/exceeding the WhatsApp limit of 20/);
  });

  it('rejects duplicate actions', () => {
    expect(() =>
      wa.buildButtonsAction({
        version: 1,
        step: 's',
        options: [
          { action: 'a', title: 'One' },
          { action: 'a', title: 'Two' },
        ],
      }),
    ).toThrowError(/Duplicate action/);
  });

  it('propagates codec errors for unsafe actions', () => {
    expect(() =>
      wa.buildButtonsAction({ version: 1, step: 's', options: [{ action: 'a:b', title: 'Bad' }] }),
    ).toThrowError(PayloadError);
  });
});

describe('buildListAction', () => {
  it('builds sections with versioned row ids', () => {
    expect(
      wa.buildListAction({
        version: 2,
        step: 'awaiting_slot',
        buttonText: 'Choose meal',
        sections: [
          {
            title: 'Meals',
            rows: [
              { action: 'lunch', title: 'Lunch', description: 'Served at 1 PM' },
              { action: 'dinner', title: 'Dinner' },
            ],
          },
        ],
      }),
    ).toEqual({
      button: 'Choose meal',
      sections: [
        {
          title: 'Meals',
          rows: [
            { id: 'v2:awaiting_slot:lunch', title: 'Lunch', description: 'Served at 1 PM' },
            { id: 'v2:awaiting_slot:dinner', title: 'Dinner' },
          ],
        },
      ],
    });
  });

  it('caps total rows across all sections at 10', () => {
    const rows10 = Array.from({ length: WHATSAPP_LIMITS.maxListRows }, (_, i) => ({
      action: `r${i}`,
      title: `R${i}`,
    }));
    expect(
      wa.buildListAction({ version: 1, step: 's', buttonText: 'Pick', sections: [{ rows: rows10 }] }),
    ).toBeTruthy();
    expect(() =>
      wa.buildListAction({
        version: 1,
        step: 's',
        buttonText: 'Pick',
        sections: [{ rows: rows10 }, { rows: [{ action: 'extra', title: 'Extra' }] }],
      }),
    ).toThrowError(/at most 10 rows/);
  });

  it('rejects over-limit row titles, descriptions, section titles, and button label', () => {
    expect(() =>
      wa.buildListAction({
        version: 1,
        step: 's',
        buttonText: 'Pick',
        sections: [{ rows: [{ action: 'a', title: 'x'.repeat(WHATSAPP_LIMITS.maxRowTitle + 1) }] }],
      }),
    ).toThrowError(/exceeding the WhatsApp limit of 24/);

    expect(() =>
      wa.buildListAction({
        version: 1,
        step: 's',
        buttonText: 'Pick',
        sections: [
          {
            rows: [
              {
                action: 'a',
                title: 'A',
                description: 'y'.repeat(WHATSAPP_LIMITS.maxRowDescription + 1),
              },
            ],
          },
        ],
      }),
    ).toThrowError(/exceeding the WhatsApp limit of 72/);

    expect(() =>
      wa.buildListAction({
        version: 1,
        step: 's',
        buttonText: 'Pick',
        sections: [{ title: 'z'.repeat(WHATSAPP_LIMITS.maxSectionTitle + 1), rows: [{ action: 'a', title: 'A' }] }],
      }),
    ).toThrowError(/exceeding the WhatsApp limit of 24/);

    expect(() =>
      wa.buildListAction({
        version: 1,
        step: 's',
        buttonText: 'w'.repeat(WHATSAPP_LIMITS.maxListButtonText + 1),
        sections: [{ rows: [{ action: 'a', title: 'A' }] }],
      }),
    ).toThrowError(/exceeding the WhatsApp limit of 20/);
  });

  it('rejects empty sections', () => {
    expect(() =>
      wa.buildListAction({ version: 1, step: 's', buttonText: 'Pick', sections: [{ rows: [] }] }),
    ).toThrowError(/at least one row/);
  });

  it('rejects duplicate actions across sections', () => {
    expect(() =>
      wa.buildListAction({
        version: 1,
        step: 's',
        buttonText: 'Pick',
        sections: [
          { rows: [{ action: 'a', title: 'A' }] },
          { rows: [{ action: 'a', title: 'A again' }] },
        ],
      }),
    ).toThrowError(/Duplicate action/);
  });
});

describe('extractInboundInteraction', () => {
  it('extracts button_reply ids', () => {
    expect(
      extractInboundInteraction({
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'v4:awaiting_slot:lunch', title: 'Lunch' },
        },
      }),
    ).toEqual({ kind: 'payload', rawId: 'v4:awaiting_slot:lunch' });
  });

  it('extracts list_reply ids', () => {
    expect(
      extractInboundInteraction({
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: { id: 'v4:awaiting_slot:lunch', title: 'Lunch' },
        },
      }),
    ).toEqual({ kind: 'payload', rawId: 'v4:awaiting_slot:lunch' });
  });

  it('extracts text bodies', () => {
    expect(extractInboundInteraction({ type: 'text', text: { body: 'cancel' } })).toEqual({
      kind: 'text',
      text: 'cancel',
    });
  });

  it('returns undefined for unsupported or junk messages', () => {
    expect(extractInboundInteraction({ type: 'image', image: { id: 'x' } })).toBeUndefined();
    expect(extractInboundInteraction('not-a-message')).toBeUndefined();
    expect(extractInboundInteraction(null)).toBeUndefined();
    expect(extractInboundInteraction(undefined)).toBeUndefined();
  });
});

describe('round trip', () => {
  it('built buttons resolve as CURRENT on a fresh webhook', () => {
    const action = wa.buildButtonsAction({
      version: 4,
      step: 'awaiting_slot',
      options: [{ action: 'lunch', title: 'Lunch (1 PM)' }],
    });
    const buttonId = action.buttons[0]!.reply.id;

    const inbound = extractInboundInteraction({
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: buttonId, title: 'Lunch (1 PM)' },
      },
    });
    expect(inbound).toEqual({ kind: 'payload', rawId: buttonId });

    const intent = guard.resolveIntent(
      { rawId: inbound!.kind === 'payload' ? inbound!.rawId : '' },
      {
        currentStep: 'awaiting_slot',
        flowVersion: 4,
        historyStack: ['home', 'awaiting_slot'],
      },
    );
    expect(intent).toMatchObject({ kind: 'current', action: 'lunch' });
  });

  it('built list rows rewind correctly when clicked later', () => {
    const action = wa.buildListAction({
      version: 2,
      step: 'awaiting_plan',
      buttonText: 'Pick plan',
      sections: [{ rows: [{ action: 'starter', title: 'Starter box' }] }],
    });
    const rowId = action.sections[0]!.rows[0]!.id;

    // Session has since advanced to awaiting_slot at v4.
    const intent = guard.resolveIntent({ rawId: rowId }, {
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
});

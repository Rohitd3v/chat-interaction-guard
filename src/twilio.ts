/**
 * Twilio Content API adapter (WhatsApp).
 *
 * Builds the `types` object for Twilio's Content API — `twilio/quick-reply`
 * and `twilio/list-picker` — with versioned reply ids in the `id` field, and
 * normalizes inbound webhooks for `resolveIntent`. Pure objects, zero
 * dependencies.
 *
 * Twilio is a proxy in front of WhatsApp, so it inherits WhatsApp's rules but
 * adds two constraints of its own:
 *
 *  - The reply id travels in `id`, capped at **200 characters** — generous
 *    compared with Telegram's 64.
 *  - Quick replies allow up to **10 buttons for templates**, but only
 *    **3 for an in-session message**. Most chatbots are in-session, so 3 is
 *    the default here; opt into 10 explicitly when building a template.
 *
 * `twilio/list-picker` is additionally session-only: it cannot open a
 * business-initiated conversation and is not submitted for approval.
 */
import type { InteractionGuard } from './guard.js';
import { charCount, isRecord } from './internal/guards.js';

export const TWILIO_LIMITS = {
  /** Reply id ceiling, in the `id` field of a button or list item. */
  maxIdLength: 200,
  /** Message body shown above the buttons. */
  maxBodyLength: 1024,
  /** Quick-reply button label. */
  maxButtonTitle: 20,
  /** Quick-reply buttons in an in-session WhatsApp message. */
  maxQuickRepliesInSession: 3,
  /** Quick-reply buttons in a template (out-of-session). */
  maxQuickRepliesInTemplate: 10,
  /** List-picker items. */
  maxListItems: 10,
  /** List-picker item label. */
  maxItemText: 24,
  /** List-picker item description (Twilio requires one). */
  maxItemDescription: 72,
  /** Label of the button that opens the list picker. */
  maxPickerButton: 24,
} as const;

export type TwilioErrorCode =
  | 'empty_options'
  | 'too_many_buttons'
  | 'too_many_items'
  | 'invalid_body'
  | 'invalid_title'
  | 'invalid_description'
  | 'duplicate_action'
  | 'id_too_long';

/** Thrown when a Twilio content fragment violates a platform constraint. */
export class TwilioError extends Error {
  readonly code: TwilioErrorCode;

  constructor(code: TwilioErrorCode, message: string) {
    super(message);
    this.name = 'TwilioError';
    this.code = code;
  }
}

export interface QuickReplyOption {
  /** Encoded into the button `id` (must pass the codec's safe-token rules). */
  readonly action: string;
  /** Visible label, max 20 characters. */
  readonly title: string;
}

export interface ListItemOption {
  readonly action: string;
  /** Visible item label, max 24 characters. */
  readonly item: string;
  /** Visible description, max 72 characters. Twilio marks this required. */
  readonly description: string;
}

export interface TwilioQuickReply {
  readonly type: 'QUICK_REPLY';
  readonly title: string;
  readonly id: string;
}

export interface TwilioListItem {
  readonly id: string;
  readonly item: string;
  readonly description: string;
}

export interface TwilioQuickReplyContent {
  readonly body: string;
  readonly actions: readonly TwilioQuickReply[];
}

export interface TwilioListPickerContent {
  readonly body: string;
  readonly button: string;
  readonly items: readonly TwilioListItem[];
}

export interface TwilioAdapter {
  /**
   * Build a `twilio/quick-reply` content body whose button `id`s are encoded
   * with the same codec as the bound guard.
   *
   * In-session messages cap out at 3 buttons. Pass
   * `{ maxQuickReplies: 10 }` on the adapter when building a template.
   */
  buildQuickReplies(input: {
    readonly version: number;
    readonly step: string;
    readonly body: string;
    readonly options: readonly QuickReplyOption[];
  }): TwilioQuickReplyContent;

  /**
   * Build a `twilio/list-picker` content body. Twilio's picker is a flat item
   * list — there are no sections, unlike Meta's native list message.
   */
  buildListPicker(input: {
    readonly version: number;
    readonly step: string;
    readonly body: string;
    readonly button: string;
    readonly items: readonly ListItemOption[];
  }): TwilioListPickerContent;
}

export type TwilioAdapterOptions = {
  /**
   * Quick-reply button ceiling. Defaults to 3 (an in-session WhatsApp
   * message). Raise to 10 when generating a template.
   */
  readonly maxQuickReplies?: number | undefined;
};

function assertBounded(
  field: string,
  value: string,
  max: number,
  code: 'invalid_title' | 'invalid_description' | 'invalid_body',
  limitLabel: string,
): void {
  if (typeof value !== 'string' || charCount(value) === 0) {
    throw new TwilioError(code, `${field} must be a non-empty string`);
  }
  const length = charCount(value);
  if (length > max) {
    throw new TwilioError(
      code,
      `${field} is ${length} characters, exceeding the Twilio ${limitLabel} limit of ${max}`,
    );
  }
}

function assertBody(body: string): void {
  assertBounded('body', body, TWILIO_LIMITS.maxBodyLength, 'invalid_body', 'body');
}

/**
 * Enforce the 200-character `id` ceiling. As with the Slack value ceiling,
 * this only bites callers who raise `maxPayloadLength` past 200 — the codec's
 * 256 default already rejects anything longer first.
 */
function assertIdLength(id: string): void {
  const length = charCount(id);
  if (length > TWILIO_LIMITS.maxIdLength) {
    throw new TwilioError(
      'id_too_long',
      `Reply id is ${length} characters, exceeding Twilio's ${TWILIO_LIMITS.maxIdLength}-character id limit.
Offending id: ${JSON.stringify(id)}`,
    );
  }
}

export function createTwilioAdapter(
  guard: InteractionGuard,
  options: TwilioAdapterOptions = {},
): TwilioAdapter {
  const maxQuickReplies =
    options.maxQuickReplies ?? TWILIO_LIMITS.maxQuickRepliesInSession;
  if (maxQuickReplies > TWILIO_LIMITS.maxQuickRepliesInTemplate) {
    throw new TwilioError(
      'too_many_buttons',
      `Twilio allows at most ${TWILIO_LIMITS.maxQuickRepliesInTemplate} quick-reply buttons, even in a template.`,
    );
  }

  return {
    buildQuickReplies({ version, step, body, options: buttons }) {
      if (buttons.length === 0) {
        throw new TwilioError('empty_options', 'At least one quick-reply option is required.');
      }
      if (buttons.length > maxQuickReplies) {
        throw new TwilioError(
          'too_many_buttons',
          `Got ${buttons.length} quick replies, but this adapter allows ${maxQuickReplies}. ` +
            `In-session WhatsApp messages cap at ${TWILIO_LIMITS.maxQuickRepliesInSession}; ` +
            `templates may use up to ${TWILIO_LIMITS.maxQuickRepliesInTemplate}.`,
        );
      }
      assertBody(body);

      const seen = new Set<string>();
      const actions = buttons.map((option) => {
        assertBounded(
          `Quick-reply title for "${option.action}"`,
          option.title,
          TWILIO_LIMITS.maxButtonTitle,
          'invalid_title',
          'button title',
        );
        if (seen.has(option.action)) {
          throw new TwilioError(
            'duplicate_action',
            `Duplicate action "${option.action}" — quick-reply ids must be unique.`,
          );
        }
        seen.add(option.action);

        const id = guard.encode({ version, step, action: option.action });
        assertIdLength(id);
        return { type: 'QUICK_REPLY' as const, title: option.title, id };
      });

      return { body, actions };
    },

    buildListPicker({ version, step, body, button, items }) {
      if (items.length === 0) {
        throw new TwilioError('empty_options', 'At least one list item is required.');
      }
      if (items.length > TWILIO_LIMITS.maxListItems) {
        throw new TwilioError(
          'too_many_items',
          `Twilio list pickers allow at most ${TWILIO_LIMITS.maxListItems} items, got ${items.length}.`,
        );
      }
      assertBody(body);
      assertBounded('List-picker button', button, TWILIO_LIMITS.maxPickerButton, 'invalid_title', 'button');

      const seen = new Set<string>();
      const outItems = items.map((option) => {
        assertBounded(
          `List item "${option.action}"`,
          option.item,
          TWILIO_LIMITS.maxItemText,
          'invalid_title',
          'item',
        );
        assertBounded(
          `List item description "${option.action}"`,
          option.description,
          TWILIO_LIMITS.maxItemDescription,
          'invalid_description',
          'item description',
        );
        if (seen.has(option.action)) {
          throw new TwilioError(
            'duplicate_action',
            `Duplicate action "${option.action}" — list item ids must be unique.`,
          );
        }
        seen.add(option.action);

        const id = guard.encode({ version, step, action: option.action });
        assertIdLength(id);
        return { id, item: option.item, description: option.description };
      });

      return { body, button, items: outItems };
    },
  };
}

/**
 * Normalize an inbound Twilio webhook (`req.body`) into the input shape of
 * `guard.resolveIntent`.
 *
 * Twilio returns the selected button's `id` in `ButtonPayload` for quick
 * replies, and the selected list item in `ListItemSelected.id` for list
 * pickers — both are the encoded reply id we stamped at build time.
 */
export function extractTwilioInteraction(body: unknown): InboundTwilioInteraction | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const buttonPayload = body.ButtonPayload;
  if (typeof buttonPayload === 'string' && buttonPayload.length > 0) {
    return { kind: 'payload', rawId: buttonPayload };
  }
  const selected = body.ListItemSelected;
  if (isRecord(selected) && typeof selected.id === 'string' && selected.id.length > 0) {
    return { kind: 'payload', rawId: selected.id };
  }
  const bodyText = body.Body;
  if (typeof bodyText === 'string' && bodyText.length > 0) {
    return { kind: 'text', text: bodyText };
  }
  return undefined;
}

export type InboundTwilioInteraction =
  | { readonly kind: 'payload'; readonly rawId: string }
  | { readonly kind: 'text'; readonly text: string };

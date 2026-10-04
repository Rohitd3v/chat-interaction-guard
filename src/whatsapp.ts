/**
 * WhatsApp Cloud API adapter (Meta).
 *
 * Builds `interactive.action` fragments with versioned reply ids and
 * normalizes inbound webhook messages for `resolveIntent`. Pure objects,
 * zero dependencies.
 *
 * Constraints are enforced at build time (fail fast, before Meta rejects
 * the whole webhook with a vague error):
 *  - Button messages: max 3 buttons, title ≤ 20 characters.
 *  - List messages: max 10 rows total across sections, list button label
 *    ≤ 20 characters, row title ≤ 24, row description ≤ 72, section title ≤ 24.
 */
import type { InteractionGuard } from './guard.js';
import { charCount, isRecord } from './internal/guards.js';

export const WHATSAPP_LIMITS = {
  maxButtons: 3,
  maxListRows: 10,
  maxButtonTitle: 20,
  maxListButtonText: 20,
  maxRowTitle: 24,
  maxRowDescription: 72,
  maxSectionTitle: 24,
} as const;

export type WhatsAppErrorCode =
  | 'empty_options'
  | 'too_many_buttons'
  | 'too_many_rows'
  | 'invalid_title'
  | 'invalid_description'
  | 'duplicate_action';

/** Thrown when an outbound fragment violates a WhatsApp platform constraint. */
export class WhatsAppError extends Error {
  readonly code: WhatsAppErrorCode;

  constructor(code: WhatsAppErrorCode, message: string) {
    super(message);
    this.name = 'WhatsAppError';
    this.code = code;
  }
}

export interface ButtonOption {
  /** Encoded into the reply id (must pass the codec's safe-token rules). */
  readonly action: string;
  /** Visible button label, max 20 characters. */
  readonly title: string;
}

export interface ListRowOption {
  readonly action: string;
  /** Visible row title, max 24 characters. */
  readonly title: string;
  /** Optional row description, max 72 characters. */
  readonly description?: string | undefined;
}

export interface ListSectionInput {
  /** Optional section title, max 24 characters. */
  readonly title?: string | undefined;
  readonly rows: readonly ListRowOption[];
}

export interface WhatsAppReplyButton {
  readonly type: 'reply';
  readonly reply: {
    readonly id: string;
    readonly title: string;
  };
}

export interface WhatsAppListRow {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
}

export interface WhatsAppListSection {
  readonly title?: string | undefined;
  readonly rows: readonly WhatsAppListRow[];
}

export interface WhatsAppAdapter {
  /**
   * Build the value for `interactive.action` of a `type: "button"` message:
   * `{ buttons: [{ type: 'reply', reply: { id, title } }, …] }`.
   */
  buildButtonsAction(input: {
    readonly version: number;
    readonly step: string;
    readonly options: readonly ButtonOption[];
  }): { readonly buttons: readonly WhatsAppReplyButton[] };

  /**
   * Build the value for `interactive.action` of a `type: "list"` message:
   * `{ button, sections: [{ title?, rows: [{ id, title, description? }] }] }`.
   */
  buildListAction(input: {
    readonly version: number;
    readonly step: string;
    readonly buttonText: string;
    readonly sections: readonly ListSectionInput[];
  }): { readonly button: string; readonly sections: readonly WhatsAppListSection[] };
}

function assertTitle(field: string, value: string, max: number): void {
  if (typeof value !== 'string' || charCount(value) === 0) {
    throw new WhatsAppError('invalid_title', `${field} must be a non-empty string`);
  }
  const length = charCount(value);
  if (length > max) {
    throw new WhatsAppError(
      'invalid_title',
      `${field} is ${length} characters, exceeding the WhatsApp limit of ${max}`,
    );
  }
}

/**
 * Create a WhatsApp adapter bound to a guard instance, so reply ids are
 * always encoded with the same codec configuration used by `resolveIntent`.
 */
export function createWhatsAppAdapter(guard: InteractionGuard): WhatsAppAdapter {
  return {
    buildButtonsAction({ version, step, options }) {
      if (options.length === 0) {
        throw new WhatsAppError('empty_options', 'At least one button option is required.');
      }
      if (options.length > WHATSAPP_LIMITS.maxButtons) {
        throw new WhatsAppError(
          'too_many_buttons',
          `WhatsApp allows at most ${WHATSAPP_LIMITS.maxButtons} quick-reply buttons, got ${options.length}. Use buildListAction for more options.`,
        );
      }
      const seen = new Set<string>();
      const buttons = options.map((option) => {
        assertTitle('Button title', option.title, WHATSAPP_LIMITS.maxButtonTitle);
        if (seen.has(option.action)) {
          throw new WhatsAppError(
            'duplicate_action',
            `Duplicate action "${option.action}" — reply ids must be unique.`,
          );
        }
        seen.add(option.action);
        return {
          type: 'reply' as const,
          reply: {
            id: guard.encode({ version, step, action: option.action }),
            title: option.title,
          },
        };
      });
      return { buttons };
    },

    buildListAction({ version, step, buttonText, sections }) {
      assertTitle('List button label', buttonText, WHATSAPP_LIMITS.maxListButtonText);
      if (sections.length === 0) {
        throw new WhatsAppError('empty_options', 'At least one section is required.');
      }
      const seen = new Set<string>();
      let totalRows = 0;
      const outSections = sections.map((section) => {
        if (section.title !== undefined) {
          assertTitle('Section title', section.title, WHATSAPP_LIMITS.maxSectionTitle);
        }
        if (section.rows.length === 0) {
          throw new WhatsAppError('empty_options', 'Every section needs at least one row.');
        }
        const rows = section.rows.map((row) => {
          totalRows += 1;
          if (totalRows > WHATSAPP_LIMITS.maxListRows) {
            throw new WhatsAppError(
              'too_many_rows',
              `WhatsApp list messages allow at most ${WHATSAPP_LIMITS.maxListRows} rows across all sections.`,
            );
          }
          assertTitle('Row title', row.title, WHATSAPP_LIMITS.maxRowTitle);
          if (row.description !== undefined) {
            const length = charCount(row.description);
            if (length > WHATSAPP_LIMITS.maxRowDescription) {
              throw new WhatsAppError(
                'invalid_description',
                `Row description is ${length} characters, exceeding the WhatsApp limit of ${WHATSAPP_LIMITS.maxRowDescription}`,
              );
            }
          }
          if (seen.has(row.action)) {
            throw new WhatsAppError(
              'duplicate_action',
              `Duplicate action "${row.action}" across sections — row ids must be unique.`,
            );
          }
          seen.add(row.action);
          const id = guard.encode({ version, step, action: row.action });
          return row.description === undefined
            ? { id, title: row.title }
            : { id, title: row.title, description: row.description };
        });
        return section.title === undefined ? { rows } : { title: section.title, rows };
      });
      return { button: buttonText, sections: outSections };
    },
  };
}

/**
 * A normalized inbound interaction, matching the input shape of
 * `guard.resolveIntent`.
 */
export type InboundInteraction =
  | { readonly kind: 'payload'; readonly rawId: string }
  | { readonly kind: 'text'; readonly text: string };

/**
 * Normalize an inbound WhatsApp webhook message (the object inside
 * `entry[].changes[].value.messages[]`) into the input shape of
 * `guard.resolveIntent`.
 *
 * Returns `undefined` for non-interactive, non-text messages (media,
 * reactions, system messages, …) — apps decide how to respond to those.
 */
export function extractInboundInteraction(message: unknown): InboundInteraction | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const interactive = message.interactive;
  if (isRecord(interactive)) {
    for (const replyKey of ['button_reply', 'list_reply'] as const) {
      const reply = interactive[replyKey];
      if (isRecord(reply) && typeof reply.id === 'string' && reply.id.length > 0) {
        return { kind: 'payload', rawId: reply.id };
      }
    }
  }
  const text = message.text;
  if (isRecord(text) && typeof text.body === 'string' && text.body.length > 0) {
    return { kind: 'text', text: text.body };
  }
  return undefined;
}

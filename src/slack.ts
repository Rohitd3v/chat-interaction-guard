/**
 * Slack Block Kit adapter.
 *
 * Builds `actions` blocks whose button `value` carries a versioned reply id,
 * and normalizes inbound interaction payloads for `resolveIntent`. Pure
 * objects, zero dependencies.
 *
 * Slack is the most permissive of the channels here — `value` allows 2000
 * characters against Telegram's 64 — but it is *not* safe by default, for a
 * different reason: Slack never invalidates an old message. Every button ever
 * posted to a channel stays live indefinitely, which is the Immutable Canvas
 * problem in its purest form.
 *
 * Constraints enforced at build time (fail fast, before Slack rejects the
 * `chat.update` with `invalid_blocks`):
 *  - Max 25 elements in a single `actions` block.
 *  - Button `text` max 75 characters (Slack truncates past that).
 *  - Button `value` max 2000 characters.
 *  - `action_id` max 255 characters, unique within the block.
 */
import type { InteractionGuard } from './guard.js';

export const SLACK_LIMITS = {
  /** Hard Slack limit: max 25 elements in one `actions` block. */
  maxElementsPerBlock: 25,
  /** Slack lays out roughly 5 buttons per row before wrapping. */
  maxRowSize: 5,
  /** Button label ceiling; Slack truncates anything longer. */
  maxButtonText: 75,
  /** Button `value` — where the encoded reply id travels. */
  maxValueLength: 2000,
  /** `action_id` must be unique within the containing block. */
  maxActionIdLength: 255,
  /** `block_id` length ceiling. */
  maxBlockIdLength: 255,
} as const;

export type SlackErrorCode =
  | 'empty_options'
  | 'too_many_elements'
  | 'invalid_text'
  | 'value_too_long'
  | 'duplicate_action'
  | 'invalid_action_id';

/** Thrown when a Block Kit fragment violates a Slack platform constraint. */
export class SlackError extends Error {
  readonly code: SlackErrorCode;

  constructor(code: SlackErrorCode, message: string) {
    super(message);
    this.name = 'SlackError';
    this.code = code;
  }
}

export interface SlackButtonOption {
  /** Encoded into the button `value` (must pass the codec's safe-token rules). */
  readonly action: string;
  /** Visible label, max 75 characters. */
  readonly text: string;
  /** Optional per-button `action_id`; defaults to the block-level action id. */
  readonly actionId?: string | undefined;
}

export interface SlackButton {
  readonly type: 'button';
  readonly text: { readonly type: 'plain_text'; readonly text: string };
  readonly value: string;
  readonly action_id: string;
}

export interface SlackActionsBlock {
  readonly type: 'actions';
  readonly block_id: string;
  readonly elements: readonly SlackButton[];
}

export interface SlackAdapter {
  /**
   * Build a Slack `actions` block whose button `value`s are encoded with the
   * same codec as the bound guard.
   *
   * Slack has no nested "row" concept — elements flow inline and wrap on their
   * own — so `rows` is accepted purely to mirror the Telegram API and to let
   * callers control grouping. Flattening preserves render order.
   */
  buildActionsBlock(input: {
    readonly version: number;
    readonly step: string;
    readonly rows: readonly (readonly SlackButtonOption[])[];
    /** Optional `block_id`; defaults to `chat-interaction`. */
    readonly blockId?: string | undefined;
  }): SlackActionsBlock;
}

export type SlackAdapterOptions = {
  /**
   * `action_id` stamped on every button unless the option overrides it.
   * Slack routes on `action_id` and echoes it back in the interaction payload,
   * so it must be stable for the app to recognise its own clicks.
   */
  readonly actionId?: string | undefined;
};

export const DEFAULT_SLACK_ACTION_ID = 'chat_interaction';

/** Slack counts characters, not bytes, for text and value fields. */
function charCount(value: string): number {
  return [...value].length;
}

function assertText(field: string, value: string, max: number): void {
  if (typeof value !== 'string' || charCount(value) === 0) {
    throw new SlackError('invalid_text', `${field} must be a non-empty string`);
  }
  const length = charCount(value);
  if (length > max) {
    throw new SlackError(
      'invalid_text',
      `${field} is ${length} characters, exceeding the Slack limit of ${max}`,
    );
  }
}

function assertActionId(value: string): void {
  const length = charCount(value);
  if (length === 0) {
    throw new SlackError('invalid_action_id', 'actionId must be a non-empty string');
  }
  if (length > SLACK_LIMITS.maxActionIdLength) {
    throw new SlackError(
      'invalid_action_id',
      `actionId is ${length} characters, exceeding the Slack limit of ${SLACK_LIMITS.maxActionIdLength}`,
    );
  }
}

/**
 * Create a Slack adapter bound to a guard instance, so button values are
 * always encoded with the same codec configuration used by `resolveIntent`.
 */
export function createSlackAdapter(
  guard: InteractionGuard,
  options: SlackAdapterOptions = {},
): SlackAdapter {
  const actionId = options.actionId ?? DEFAULT_SLACK_ACTION_ID;
  assertActionId(actionId);

  return {
    buildActionsBlock({ version, step, rows, blockId = 'chat-interaction' }) {
      if (rows.length === 0) {
        throw new SlackError('empty_options', 'At least one button row is required.');
      }
      if (charCount(blockId) === 0) {
        throw new SlackError('invalid_text', 'blockId must be a non-empty string');
      }
      if (charCount(blockId) > SLACK_LIMITS.maxBlockIdLength) {
        throw new SlackError(
          'invalid_text',
          `blockId is ${charCount(blockId)} characters, exceeding the Slack limit of ${SLACK_LIMITS.maxBlockIdLength}`,
        );
      }

      const seen = new Set<string>();
      const elements: SlackButton[] = [];

      for (const row of rows) {
        if (row.length === 0) {
          throw new SlackError('empty_options', 'Every button row must contain at least one button.');
        }
        if (row.length > SLACK_LIMITS.maxRowSize) {
          throw new SlackError(
            'too_many_elements',
            `A Slack button row holds at most ${SLACK_LIMITS.maxRowSize} buttons before wrapping, got ${row.length}.`,
          );
        }

        for (const option of row) {
          assertText(`button text for "${option.action}"`, option.text, SLACK_LIMITS.maxButtonText);

          const buttonActionId = option.actionId ?? actionId;
          assertActionId(buttonActionId);

          // Surfaces PayloadError('unsafe_token') for non-token characters.
          const value = guard.encode({ version, step, action: option.action });

          const length = charCount(value);
          if (length > SLACK_LIMITS.maxValueLength) {
            throw new SlackError(
              'value_too_long',
              `Button value is ${length} characters, exceeding Slack's ${SLACK_LIMITS.maxValueLength}-character limit.
Offending value: ${JSON.stringify(value)}`,
            );
          }

          if (seen.has(option.action)) {
            throw new SlackError(
              'duplicate_action',
              `Duplicate action "${option.action}" — every button in a Slack actions block must carry a distinct reply id.`,
            );
          }
          seen.add(option.action);

          elements.push({
            type: 'button',
            text: { type: 'plain_text', text: option.text },
            value,
            action_id: buttonActionId,
          });
        }
      }

      if (elements.length > SLACK_LIMITS.maxElementsPerBlock) {
        throw new SlackError(
          'too_many_elements',
          `Slack allows at most ${SLACK_LIMITS.maxElementsPerBlock} elements in one actions block, got ${elements.length}.`,
        );
      }

      return { type: 'actions', block_id: blockId, elements };
    },
  };
}

export type SlackInboundAction =
  | { readonly kind: 'payload'; readonly rawId: string; readonly actionId: string | undefined }
  | { readonly kind: 'text'; readonly text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Normalize an inbound Slack interactivity payload — the `payload` object
 * delivered to `block_actions` / `view_submission` / `shortcut` callbacks —
 * into the input shape of `guard.resolveIntent`.
 *
 * Slack sends a `view_submission` for modals, where the encoded value is not
 * at `actions[0].value`; only block actions carry it. Returns `undefined`
 * for payloads that carry no interaction (e.g. a plain `view_submission`),
 * leaving the app to decide how to respond.
 */
export function extractSlackAction(payload: unknown): SlackInboundAction | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const actions = payload.actions;
  if (Array.isArray(actions)) {
    for (const action of actions) {
      if (!isRecord(action)) continue;
      const value = action.value;
      if (typeof value === 'string' && value.length > 0) {
        const actionId = action.action_id;
        return {
          kind: 'payload',
          rawId: value,
          actionId: typeof actionId === 'string' ? actionId : undefined,
        };
      }
    }
  }
  const text = payload.text;
  if (isRecord(text) && typeof text.text === 'string' && text.text.length > 0) {
    return { kind: 'text', text: text.text };
  }
  return undefined;
}

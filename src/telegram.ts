/**
 * Telegram adapter.
 *
 * Telegram Inline Keyboards use `callback_data`, sealed at **64 UTF-8 bytes**
 * at message send time. Telegram also silently strips `&` (and several other
 * chars) from callback_data, so a guarded id produced by a codec using `:` as
 * delimiter — `v1:step:help_me` — would arrive at your handler as
 * `v1:keydata` and mismatch.
 *
 * Adapters built with `createTelegramAdapter` enforce `followStrict: true` by
 * default: any callback_data containing a Telegram-dangerous character is
 * rejected at build time so the caller sanitises step/action labels before
 * encoding (title-case labels, ASCII-only).
 *
 * Emoji in button text is fine — users see the emoji; only `callback_data`
 * (the machine value) is constrained.
 */
import type { InteractionGuard } from './guard.js';
import { byteLength } from './codec.js';

export const TELEGRAM_CALLBACK_DATA_LIMIT = 64;

/** Telegram silently strips these characters from callback_data at send time. */
export const TELEGRAM_CALLBACK_DANGEROUS_CHARS = /[& +'"<>,]/;

export type TelegramErrorCode =
  | 'empty_options'
  | 'too_many_buttons'
  | 'callback_data_too_long'
  | 'duplicate_action'
  | 'callback_data_unsafe';

/** Thrown when a Telegram fragment violates a platform constraint. */
export class TelegramError extends Error {
  readonly code: TelegramErrorCode;

  constructor(code: TelegramErrorCode, message: string) {
    super(message);
    this.name = 'TelegramError';
    this.code = code;
  }
}

export interface TelegramInlineButton {
  readonly text: string;
  readonly callback_data: string;
}

export interface TelegramKeyboard {
  readonly inline_keyboard: readonly TelegramInlineButton[][];
}

export interface TelegramAdapter {
  /**
   * Build a Telegram Inline Keyboard whose `callback_data` values are
   * encoded with the same codec as the bound guard.
   *
   * `rows` is `Array<Array<{ action, text }>>` — rows are keyboard rows
   * (max 5 buttons per row; 20 total across all rows).
   */
  buildKeyboard(input: {
    readonly version: number;
    readonly step: string;
    readonly rows: readonly ({ readonly action: string; readonly text: string }[])[];
  }): TelegramKeyboard;
}

export type TelegramAdapterOptions = {
  /** Fail when callback_data contains Telegram-dangerous characters (default: true). */
  readonly followStrict?: boolean;
};

export function createTelegramAdapter(
  guard: InteractionGuard,
  options: TelegramAdapterOptions = {},
): TelegramAdapter {
  const strict = options.followStrict !== false;

  return {
    buildKeyboard({ version, step, rows }) {
      if (rows.length === 0) {
        throw new TelegramError('empty_options', 'At least one button row is required.');
      }

      const seen = new Set<string>();
      const keyboard: TelegramInlineButton[][] = [];
      let totalButtons = 0;

      for (const row of rows) {
        if (row.length === 0) {
          throw new TelegramError('empty_options', 'Every button row must contain at least one button.');
        }
        if (row.length > 5) {
          throw new TelegramError(
            'too_many_buttons',
            `A single Telegram inline keyboard row can display at most 5 buttons, got ${row.length}.`,
          );
        }

        const buttons: TelegramInlineButton[] = [];
        for (const button of row) {
          const id = guard.encode({ version, step, action: button.action });

          if (strict && TELEGRAM_CALLBACK_DANGEROUS_CHARS.test(id)) {
            throw new TelegramError(
              'callback_data_unsafe',
              `callback_data contains a character Telegram strips at send time (& + whitespace "'<>,).
Offending data: ${JSON.stringify(id)}
Sanitise step/action labels to [A-Za-z0-9_.-] first.`,
            );
          }
          if (byteLength(id) > TELEGRAM_CALLBACK_DATA_LIMIT) {
            throw new TelegramError(
              'callback_data_too_long',
              `callback_data is ${byteLength(id)} bytes, exceeding Telegram's ${TELEGRAM_CALLBACK_DATA_LIMIT}-byte limit.
Offending data: ${JSON.stringify(id)}`,
            );
          }

          if (seen.has(button.action)) {
            throw new TelegramError(
              'duplicate_action',
              `Duplicate action "${button.action}" — Telegram callback_data must be unique per keyboard.`,
            );
          }
          seen.add(button.action);
          buttons.push({ text: button.text, callback_data: id });
        }
        keyboard.push(buttons);
        totalButtons += buttons.length;
      }

      if (totalButtons > 20) {
        throw new TelegramError(
          'too_many_buttons',
          `Telegram allows at most 20 Inline Keyboard buttons total (5 per row × at most a handful of rows). Got ${totalButtons}.`,
        );
      }

      return { inline_keyboard: keyboard };
    },
  };
}

/**
 * Read callback_data from a Telegram Update and thread it into
 * `guard.resolveIntent({ rawId })`.
 */
export function extractTelegramCallback(callback_data: unknown): string {
  if (typeof callback_data !== 'string') {
    throw new TypeError('extractTelegramCallback expects a string `callback_data`.');
  }
  return callback_data;
}
/** Detect if a string has Telegram-dangerous chars (useful for sanitisation UI). */
export function hasDangerousChars(value: string): boolean {
  return TELEGRAM_CALLBACK_DANGEROUS_CHARS.test(value);
}


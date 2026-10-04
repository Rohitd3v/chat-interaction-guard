/**
 * Shared validation primitives for the channel adapters.
 *
 * These were duplicated verbatim across the WhatsApp, Slack and Twilio
 * adapters. They live here — unexported from every public subpath — so the
 * adapters cannot drift apart on how they measure length or narrow `unknown`.
 */

/**
 * Code-point length.
 *
 * Every adapter except Telegram counts in characters, not bytes: Meta's title
 * caps, Slack's `value`, and Twilio's `id` are all character limits. Telegram's
 * `callback_data` is the one genuine byte limit, so it uses `byteLength`
 * from `codec.ts` instead.
 */
export function charCount(value: string): number {
  return [...value].length;
}

/** Narrow an `unknown` webhook body to an object before reading fields off it. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

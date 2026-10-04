import type { DecodeResult, UnparseableReason } from './types.js';

export const DEFAULT_VERSION_PREFIX = 'v';
export const DEFAULT_DELIMITER = ':';
/** WhatsApp Cloud API hard limit: 256 bytes. */
export const DEFAULT_MAX_PAYLOAD_LENGTH = 256;

/**
 * Characters allowed in version prefixes, steps, and actions. Restricting
 * tokens to this alphabet makes the format immune to delimiter-injection
 * from user-controlled strings.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;
const DIGITS = /^\d+$/;

const encoder = new TextEncoder();

export type PayloadErrorCode =
  | 'invalid_config'
  | 'invalid_version'
  | 'unsafe_token'
  | 'too_long';

/**
 * Thrown at guard-creation or encode time — always a programmer error.
 * Decode never throws: unparseable user-controlled input returns a reason.
 */
export class PayloadError extends Error {
  readonly code: PayloadErrorCode;

  constructor(code: PayloadErrorCode, message: string) {
    super(message);
    this.name = 'PayloadError';
    this.code = code;
  }
}

export interface CodecConfig {
  readonly versionPrefix?: string | undefined;
  readonly delimiter?: string | undefined;
  readonly maxPayloadLength?: number | undefined;
}

export interface ResolvedCodecConfig {
  readonly versionPrefix: string;
  readonly delimiter: string;
  readonly maxPayloadLength: number;
}

/** Validate and apply codec defaults. Throws `PayloadError` on bad config. */
export function resolveCodecConfig(config: CodecConfig): ResolvedCodecConfig {
  const versionPrefix = config.versionPrefix ?? DEFAULT_VERSION_PREFIX;
  const delimiter = config.delimiter ?? DEFAULT_DELIMITER;
  const maxPayloadLength = config.maxPayloadLength ?? DEFAULT_MAX_PAYLOAD_LENGTH;

  if (!SAFE_TOKEN.test(versionPrefix)) {
    throw new PayloadError(
      'invalid_config',
      `versionPrefix must match [A-Za-z0-9_-]+, got: ${JSON.stringify(versionPrefix)}`,
    );
  }
  if ([...delimiter].length !== 1 || SAFE_TOKEN.test(delimiter)) {
    throw new PayloadError(
      'invalid_config',
      `delimiter must be a single character outside [A-Za-z0-9_-], got: ${JSON.stringify(delimiter)}`,
    );
  }
  if (!Number.isSafeInteger(maxPayloadLength) || maxPayloadLength < 1) {
    throw new PayloadError(
      'invalid_config',
      `maxPayloadLength must be a positive integer, got: ${maxPayloadLength}`,
    );
  }
  return { versionPrefix, delimiter, maxPayloadLength };
}

/** UTF-8 byte length (channel limits are byte limits, not character counts). */
export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

export interface EncodeInput {
  readonly version: number;
  readonly step: string;
  readonly action: string;
}

/**
 * Encode a versioned interaction id in the format
 * `v{version}{delimiter}{step}{delimiter}{action}`.
 * Throws `PayloadError` on invalid versions, unsafe tokens, or over-limit ids.
 */
export function encodeInteractionId(input: EncodeInput, config: ResolvedCodecConfig): string {
  const { version, step, action } = input;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new PayloadError(
      'invalid_version',
      `version must be a positive safe integer, got: ${version}`,
    );
  }
  assertSafeToken('step', step);
  assertSafeToken('action', action);

  const id = `${config.versionPrefix}${version}${config.delimiter}${step}${config.delimiter}${action}`;
  const bytes = byteLength(id);
  if (bytes > config.maxPayloadLength) {
    throw new PayloadError(
      'too_long',
      `Encoded id is ${bytes} bytes, exceeding maxPayloadLength of ${config.maxPayloadLength}: "${id}"`,
    );
  }
  return id;
}

function assertSafeToken(field: string, value: string): void {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) {
    throw new PayloadError(
      'unsafe_token',
      `${field} must be a non-empty string matching [A-Za-z0-9_-], got: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Strictly parse a raw interaction id. Never throws: hostile or foreign
 * strings (pasted text, third-party button ids) return a failure reason
 * instead, so webhook handlers can classify them as `unknown`.
 */
export function decodeInteractionId(rawId: string, config: ResolvedCodecConfig): DecodeResult {
  if (typeof rawId !== 'string') {
    return fail('malformed');
  }
  if (rawId.length === 0) {
    return fail('empty');
  }
  if (byteLength(rawId) > config.maxPayloadLength) {
    return fail('too_long');
  }

  const parts = rawId.split(config.delimiter);
  if (parts.length !== 3) {
    return fail('malformed');
  }
  const [versionPart, step, action] = parts as [string, string, string];

  if (versionPart === undefined || !versionPart.startsWith(config.versionPrefix)) {
    return fail('malformed');
  }
  const digits = versionPart.slice(config.versionPrefix.length);
  if (!DIGITS.test(digits)) {
    return fail('invalid_version');
  }
  const version = Number(digits);
  if (!Number.isSafeInteger(version) || version < 1) {
    return fail('invalid_version');
  }
  if (!SAFE_TOKEN.test(step) || !SAFE_TOKEN.test(action)) {
    return fail('unsafe_token');
  }

  return { ok: true, payload: { version, step, action, rawId } };
}

function fail(reason: UnparseableReason): DecodeResult {
  return { ok: false, reason };
}

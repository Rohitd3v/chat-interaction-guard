export { createInteractionGuard } from './guard.js';
export type {
  InteractionGuard,
  InteractionGuardConfig,
  ResolvedInteractionInput,
} from './guard.js';

export {
  DEFAULT_DELIMITER,
  DEFAULT_MAX_PAYLOAD_LENGTH,
  DEFAULT_VERSION_PREFIX,
  PayloadError,
  byteLength,
  decodeInteractionId,
  encodeInteractionId,
  resolveCodecConfig,
} from './codec.js';
export type {
  CodecConfig,
  EncodeInput,
  PayloadErrorCode,
  ResolvedCodecConfig,
} from './codec.js';

export { popStep, pruneDraft, pushStep, unwindHistory } from './history.js';
export type { PruneDraftOptions, UnwindResult } from './history.js';

export type {
  DecodedPayload,
  DecodeResult,
  InteractionIntent,
  InteractionSession,
  InteractionSource,
  StaleReason,
  UnparseableReason,
} from './types.js';

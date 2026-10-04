/**
 * Core type definitions for chat-interaction-guard.
 *
 * All intent variants are readonly discriminated unions so consumers can
 * switch exhaustively and the compiler flags unhandled kinds.
 */

/** Reason a raw interaction ID could not be parsed into a payload. */
export type UnparseableReason =
  | 'empty'
  | 'malformed'
  | 'invalid_version'
  | 'unsafe_token'
  | 'too_long';

/** A successfully decoded interaction payload. */
export interface DecodedPayload {
  readonly version: number;
  readonly step: string;
  readonly action: string;
  readonly rawId: string;
}

export type DecodeResult =
  | { readonly ok: true; readonly payload: DecodedPayload }
  | { readonly ok: false; readonly reason: UnparseableReason };

/** Why an otherwise-parseable payload was classified as stale. */
export type StaleReason =
  | 'not_in_history'
  | 'future_version'
  | 'version_step_mismatch';

/** Where a global action came from. */
export type InteractionSource = 'payload' | 'text';

/**
 * The classification of an incoming interaction. This is the exhaustive
 * decision the engine makes — apps switch on `kind` and never inspect raw
 * webhook payloads for routing.
 */
export type InteractionIntent =
  | {
      readonly kind: 'current';
      readonly rawId: string;
      readonly version: number;
      readonly step: string;
      readonly action: string;
    }
  | {
      readonly kind: 'rewind';
      readonly rawId: string;
      readonly version: number;
      readonly targetStep: string;
      /** Steps discarded by the rewind (everything after the target step). */
      readonly prunedSteps: readonly string[];
      readonly action: string;
    }
  | {
      readonly kind: 'stale';
      readonly rawId: string;
      readonly reason: StaleReason;
      readonly payload: DecodedPayload;
    }
  | {
      readonly kind: 'global';
      readonly action: string;
      readonly source: InteractionSource;
      readonly rawId?: string | undefined;
      readonly payload?: DecodedPayload | undefined;
    }
  | {
      readonly kind: 'duplicate';
      readonly rawId: string;
      readonly payload?: DecodedPayload | undefined;
    }
  | {
      readonly kind: 'unknown';
      readonly reason: UnparseableReason | 'free_text';
      readonly rawId?: string | undefined;
      readonly text?: string | undefined;
    };

/**
 * The minimal session state the engine needs. Persist exactly this shape
 * alongside your domain draft data.
 */
export interface InteractionSession {
  /** The step whose prompt is currently rendered. */
  readonly currentStep: string;
  /** Monotonic render version; incremented on every transition or rewind. */
  readonly flowVersion: number;
  /** Trail of visited steps, ending with `currentStep`. */
  readonly historyStack: readonly string[];
  /** Last processed interaction ID — powers duplicate suppression. */
  readonly lastInteractionId?: string | undefined;
}

import {
  decodeInteractionId,
  encodeInteractionId,
  resolveCodecConfig,
  type CodecConfig,
  type ResolvedCodecConfig,
} from './codec.js';
import {
  pruneDraft,
  unwindHistory,
  type PruneDraftOptions,
} from './history.js';
import type {
  DecodeResult,
  InteractionIntent,
  InteractionSession,
} from './types.js';

export interface InteractionGuardConfig extends CodecConfig {
  /**
   * Actions that short-circuit the version/step matrix, at any version.
   *
   * ⚠️ Global-precedence caveat: matching is by action name only, and it
   * happens *before* the current/rewind/stale classification. Don't give a
   * step-local action the same name as a registered global — e.g. a fresh
   * `v4:awaiting_slot:cancel` click routes to `global`, never `current`.
   * (Usually what you want for `cancel`; a footgun for anything else.)
   */
  readonly globalActions?: readonly string[] | undefined;
}

export interface ResolvedInteractionInput {
  /** Interactive payload id from the webhook (button reply, list row, callback_data). */
  readonly rawId?: string | undefined;
  /** Free-text message body. Used only when `rawId` is absent. */
  readonly text?: string | undefined;
}

export interface InteractionGuard {
  readonly config: {
    readonly versionPrefix: string;
    readonly delimiter: string;
    readonly maxPayloadLength: number;
    readonly globalActions: readonly string[];
  };

  /** Encode an outbound button/list-row id. Throws `PayloadError` on bad input. */
  encode(input: { readonly version: number; readonly step: string; readonly action: string }): string;

  /** Strictly decode an inbound id. Never throws. */
  decode(rawId: string): DecodeResult;

  /** Drop draft fields owned by unwound steps. */
  pruneDraft(options: PruneDraftOptions): Record<string, unknown>;

  /** Truncate a history stack to a target step. */
  unwindHistory(stack: readonly string[], targetStep: string): ReturnType<typeof unwindHistory>;

  /**
   * Classify an incoming interaction against the session snapshot.
   * Pure function: never mutates the session, never throws for
   * user-controlled input (those become `unknown`).
   */
  resolveIntent(input: ResolvedInteractionInput, session: InteractionSession): InteractionIntent;
}

export function createInteractionGuard(config: InteractionGuardConfig = {}): InteractionGuard {
  const codecConfig: ResolvedCodecConfig = resolveCodecConfig(config);
  const globalActions = [...(config.globalActions ?? [])];
  const globalSet = new Set(globalActions);

  return {
    config: { ...codecConfig, globalActions },

    encode(input) {
      return encodeInteractionId(input, codecConfig);
    },

    decode(rawId) {
      return decodeInteractionId(rawId, codecConfig);
    },

    pruneDraft(options) {
      return pruneDraft(options);
    },

    unwindHistory(stack, targetStep) {
      return unwindHistory(stack, targetStep);
    },

    resolveIntent(input, session) {
      // ── Free-text input ─────────────────────────────────────────────
      if (input.rawId === undefined) {
        if (input.text === undefined) {
          throw new TypeError('resolveIntent requires either `rawId` or `text`.');
        }
        const normalized = input.text.trim().toLowerCase();
        if (globalSet.has(normalized)) {
          return { kind: 'global', action: normalized, source: 'text' };
        }
        return { kind: 'unknown', reason: 'free_text', text: input.text };
      }
      const rawId = input.rawId;

      // ── Duplicate suppression (webhook redelivery / double-tap) ────
      if (session.lastInteractionId !== undefined && session.lastInteractionId === rawId) {
        const decoded = decodeInteractionId(rawId, codecConfig);
        return decoded.ok
          ? { kind: 'duplicate', rawId, payload: decoded.payload }
          : { kind: 'duplicate', rawId };
      }

      // ── Parse (fail-closed) ─────────────────────────────────────────
      const decoded = decodeInteractionId(rawId, codecConfig);
      if (!decoded.ok) {
        return { kind: 'unknown', reason: decoded.reason, rawId };
      }
      const { version, step, action } = decoded.payload;

      // ── Global actions win, at any version/step ─────────────────────
      if (globalSet.has(action)) {
        return { kind: 'global', action, source: 'payload', rawId, payload: decoded.payload };
      }

      // ── Version/step matrix ─────────────────────────────────────────
      if (version > session.flowVersion) {
        // Out-of-order delivery or laggy session store: never execute
        // a payload from a "future" render.
        return { kind: 'stale', rawId, reason: 'future_version', payload: decoded.payload };
      }
      if (version === session.flowVersion) {
        if (step === session.currentStep) {
          return { kind: 'current', rawId, version, step, action };
        }
        // Same version but different step: inconsistent with the
        // versioning contract — treat as stale.
        return {
          kind: 'stale',
          rawId,
          reason: 'version_step_mismatch',
          payload: decoded.payload,
        };
      }

      // version < session.flowVersion: rewind if the step is in the trail.
      const unwind = unwindHistory(session.historyStack, step);
      if (unwind.ok) {
        return {
          kind: 'rewind',
          rawId,
          version,
          targetStep: step,
          prunedSteps: unwind.prunedSteps,
          action,
        };
      }
      return { kind: 'stale', rawId, reason: 'not_in_history', payload: decoded.payload };
    },
  };
}

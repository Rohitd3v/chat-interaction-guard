import { describe, expect, it } from 'vitest';
import { createInteractionGuard, type InteractionSession } from '../src/index.js';

const guard = createInteractionGuard({
  globalActions: ['back_button', 'cancel', 'help', 'menu'],
});

// The §7 scenario: user is on `awaiting_slot` at v4.
const session: InteractionSession = {
  currentStep: 'awaiting_slot',
  flowVersion: 4,
  historyStack: ['home', 'awaiting_plan', 'awaiting_slot'],
};

describe('resolveIntent — intent matrix', () => {
  it('CURRENT: fresh button on the active prompt', () => {
    const rawId = guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' });
    expect(guard.resolveIntent({ rawId }, session)).toEqual({
      kind: 'current',
      rawId,
      version: 4,
      step: 'awaiting_slot',
      action: 'lunch',
    });
  });

  it('REWIND: button from a prior step in the trail', () => {
    const rawId = guard.encode({ version: 2, step: 'awaiting_plan', action: 'starter' });
    expect(guard.resolveIntent({ rawId }, session)).toEqual({
      kind: 'rewind',
      rawId,
      version: 2,
      targetStep: 'awaiting_plan',
      prunedSteps: ['awaiting_slot'],
      action: 'starter',
    });
  });

  it('REWIND: clean reset to the first step prunes everything after it', () => {
    const rawId = guard.encode({ version: 1, step: 'home', action: 'start' });
    expect(guard.resolveIntent({ rawId }, session)).toMatchObject({
      kind: 'rewind',
      targetStep: 'home',
      prunedSteps: ['awaiting_plan', 'awaiting_slot'],
    });
  });

  it('STALE (not_in_history): ancient click from an unrelated flow', () => {
    // The §7 row: on awaiting_payment with stack [home, awaiting_payment],
    // an ancient click on awaiting_plan — never visited in this session.
    const paySession: InteractionSession = {
      currentStep: 'awaiting_payment',
      flowVersion: 5,
      historyStack: ['home', 'awaiting_payment'],
    };
    const rawId = guard.encode({ version: 2, step: 'awaiting_plan', action: 'starter' });
    expect(guard.resolveIntent({ rawId }, paySession)).toEqual({
      kind: 'stale',
      rawId,
      reason: 'not_in_history',
      payload: { version: 2, step: 'awaiting_plan', action: 'starter', rawId },
    });
  });

  it('STALE (future_version): out-of-order webhook delivery', () => {
    const rawId = guard.encode({ version: 6, step: 'awaiting_slot', action: 'lunch' });
    expect(guard.resolveIntent({ rawId }, session)).toMatchObject({
      kind: 'stale',
      reason: 'future_version',
    });
  });

  it('STALE (version_step_mismatch): version matches, step does not', () => {
    const rawId = guard.encode({ version: 4, step: 'awaiting_plan', action: 'starter' });
    expect(guard.resolveIntent({ rawId }, session)).toMatchObject({
      kind: 'stale',
      reason: 'version_step_mismatch',
    });
  });

  it('REWIND to the current step (older re-render of the same prompt) is a no-op', () => {
    const rawId = guard.encode({ version: 3, step: 'awaiting_slot', action: 'lunch' });
    expect(guard.resolveIntent({ rawId }, session)).toMatchObject({
      kind: 'rewind',
      targetStep: 'awaiting_slot',
      prunedSteps: [],
    });
  });

  it('is pure: never mutates the session snapshot', () => {
    const rawId = guard.encode({ version: 2, step: 'awaiting_plan', action: 'starter' });
    const before = JSON.stringify(session);
    guard.resolveIntent({ rawId }, session);
    expect(JSON.stringify(session)).toBe(before);
  });
});

describe('resolveIntent — global actions', () => {
  it('payload globals match at any version/step', () => {
    const rawId = guard.encode({ version: 1, step: 'home', action: 'cancel' });
    expect(guard.resolveIntent({ rawId }, session)).toEqual({
      kind: 'global',
      action: 'cancel',
      source: 'payload',
      rawId,
      payload: { version: 1, step: 'home', action: 'cancel', rawId },
    });
  });

  it('even "current" clicks with a global name route globally (documented precedence)', () => {
    const rawId = guard.encode({ version: 4, step: 'awaiting_slot', action: 'cancel' });
    expect(guard.resolveIntent({ rawId }, session)).toMatchObject({
      kind: 'global',
      action: 'cancel',
    });
  });

  it('text globals are trimmed and case-insensitive', () => {
    expect(guard.resolveIntent({ text: '  CANCEL ' }, session)).toEqual({
      kind: 'global',
      action: 'cancel',
      source: 'text',
    });
  });

  it('non-global free text is unknown', () => {
    expect(guard.resolveIntent({ text: 'hello there' }, session)).toEqual({
      kind: 'unknown',
      reason: 'free_text',
      text: 'hello there',
    });
  });

  it('rawId takes precedence when both rawId and text are given', () => {
    const rawId = guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' });
    expect(guard.resolveIntent({ rawId, text: 'cancel' }, session)).toMatchObject({
      kind: 'current',
      action: 'lunch',
    });
  });
});

describe('resolveIntent — duplicates & unknowns', () => {
  it('DUPLICATE: exact same rawId as lastInteractionId', () => {
    const rawId = guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' });
    const seen: InteractionSession = { ...session, lastInteractionId: rawId };
    expect(guard.resolveIntent({ rawId }, seen)).toEqual({
      kind: 'duplicate',
      rawId,
      payload: { version: 4, step: 'awaiting_slot', action: 'lunch', rawId },
    });
  });

  it('DUPLICATE takes precedence over global routing and parsing', () => {
    const rawId = guard.encode({ version: 1, step: 'home', action: 'cancel' });
    const seen: InteractionSession = { ...session, lastInteractionId: rawId };
    expect(guard.resolveIntent({ rawId }, seen)).toMatchObject({ kind: 'duplicate' });
  });

  it('DUPLICATE works even for unparseable ids', () => {
    const seen: InteractionSession = { ...session, lastInteractionId: 'junk' };
    expect(guard.resolveIntent({ rawId: 'junk' }, seen)).toEqual({
      kind: 'duplicate',
      rawId: 'junk',
    });
  });

  it('UNKNOWN: unparseable / foreign button ids never throw', () => {
    expect(guard.resolveIntent({ rawId: 'hello_world_123' }, session)).toEqual({
      kind: 'unknown',
      reason: 'malformed',
      rawId: 'hello_world_123',
    });
    expect(guard.resolveIntent({ rawId: '' }, session)).toEqual({
      kind: 'unknown',
      reason: 'empty',
      rawId: '',
    });
  });

  it('throws only on programmer error (no input at all)', () => {
    expect(() => guard.resolveIntent({}, session)).toThrowError(TypeError);
  });
});

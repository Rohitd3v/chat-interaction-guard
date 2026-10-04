import { describe, expect, it } from 'vitest';
import { popStep, pruneDraft, pushStep, unwindHistory } from '../src/index.js';

describe('pushStep', () => {
  it('appends new steps', () => {
    expect(pushStep(['home'], 'plan')).toEqual(['home', 'plan']);
  });

  it('collapses consecutive re-renders of the same step', () => {
    expect(pushStep(['home', 'slot'], 'slot')).toEqual(['home', 'slot']);
  });
});

describe('unwindHistory', () => {
  const stack = ['home', 'plan', 'slot'];

  it('rewinds to a middle step and reports pruned steps', () => {
    expect(unwindHistory(stack, 'plan')).toEqual({
      ok: true,
      stack: ['home', 'plan'],
      prunedSteps: ['slot'],
    });
  });

  it('rewinds to the first step and prunes everything after it', () => {
    expect(unwindHistory(stack, 'home')).toEqual({
      ok: true,
      stack: ['home'],
      prunedSteps: ['plan', 'slot'],
    });
  });

  it('is a no-op when targeting the current step', () => {
    expect(unwindHistory(stack, 'slot')).toEqual({ ok: true, stack, prunedSteps: [] });
  });

  it('fails when the target was never visited', () => {
    expect(unwindHistory(stack, 'payment')).toEqual({
      ok: false,
      reason: 'target_not_in_history',
    });
  });

  it('uses the most recent occurrence for repeated steps', () => {
    expect(unwindHistory(['home', 'plan', 'home', 'plan'], 'home')).toEqual({
      ok: true,
      stack: ['home', 'plan', 'home'],
      prunedSteps: ['plan'],
    });
  });
});

describe('popStep', () => {
  it('pops one step back', () => {
    expect(popStep(['home', 'plan', 'slot'])).toEqual({
      ok: true,
      stack: ['home', 'plan'],
      prunedSteps: ['slot'],
    });
  });

  it('underflows with fewer than two steps', () => {
    expect(popStep(['home'])).toEqual({ ok: false, reason: 'stack_underflow' });
    expect(popStep([])).toEqual({ ok: false, reason: 'stack_underflow' });
  });
});

describe('pruneDraft', () => {
  it('drops step-owned keys and keeps shared ones', () => {
    expect(
      pruneDraft({
        draft: {
          awaiting_slot: { slot: 'lunch' },
          'awaiting_plan:choice': 'starter',
          meta: { tz: 'UTC' },
        },
        unwoundSteps: ['awaiting_slot', 'awaiting_plan'],
      }),
    ).toEqual({ meta: { tz: 'UTC' } });
  });

  it('keeps everything when nothing was unwound', () => {
    expect(pruneDraft({ draft: { a: 1, b: 2 }, unwoundSteps: [] })).toEqual({ a: 1, b: 2 });
  });
});

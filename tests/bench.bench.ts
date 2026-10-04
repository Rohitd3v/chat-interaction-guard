import { bench, describe } from 'vitest';
import { createInteractionGuard } from '../src/index.js';

const guard = createInteractionGuard({ globalActions: ['cancel', 'help'] });
const session = {
  currentStep: 'awaiting_slot',
  flowVersion: 4,
  historyStack: ['home', 'awaiting_plan', 'awaiting_slot'],
};

describe('resolveIntent', () => {
  bench('current intent', () => {
    guard.resolveIntent({ rawId: 'v4:awaiting_slot:lunch' }, session);
  });

  bench('rewind intent', () => {
    guard.resolveIntent({ rawId: 'v2:awaiting_plan:starter' }, session);
  });

  bench('unknown intent', () => {
    guard.resolveIntent({ rawId: 'some_foreign_button_id' }, session);
  });
});

describe('encode', () => {
  bench('encode id', () => {
    guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' });
  });
});

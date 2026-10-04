import { describe, expect, it } from 'vitest';
import { PayloadError, createInteractionGuard } from '../src/index.js';

const guard = createInteractionGuard({ globalActions: ['cancel'] });

describe('encode', () => {
  it('produces the documented format', () => {
    expect(guard.encode({ version: 4, step: 'awaiting_slot', action: 'lunch' })).toBe(
      'v4:awaiting_slot:lunch',
    );
  });

  it('round-trips through decode', () => {
    const id = guard.encode({
      version: 12,
      step: 'awaiting_schedule_confirm',
      action: 'confirm_yes',
    });
    expect(guard.decode(id)).toEqual({
      ok: true,
      payload: { version: 12, step: 'awaiting_schedule_confirm', action: 'confirm_yes', rawId: id },
    });
  });

  it('supports custom prefix and delimiter', () => {
    const g = createInteractionGuard({ versionPrefix: 'f', delimiter: '|' });
    expect(g.encode({ version: 2, step: 'a', action: 'b' })).toBe('f2|a|b');
    expect(g.decode('f2|a|b')).toMatchObject({
      ok: true,
      payload: { version: 2, step: 'a', action: 'b' },
    });
  });

  it('rejects invalid versions', () => {
    expect(() => guard.encode({ version: 0, step: 'a', action: 'b' })).toThrowError(PayloadError);
    expect(() => guard.encode({ version: -1, step: 'a', action: 'b' })).toThrowError(PayloadError);
    expect(() => guard.encode({ version: 1.5, step: 'a', action: 'b' })).toThrowError(PayloadError);
    expect(() => guard.encode({ version: Number.NaN, step: 'a', action: 'b' })).toThrowError(
      PayloadError,
    );
  });

  it('rejects unsafe tokens (delimiter injection)', () => {
    expect(() => guard.encode({ version: 1, step: 'a:b', action: 'c' })).toThrowError(PayloadError);
    expect(() => guard.encode({ version: 1, step: 'a', action: 'c:d' })).toThrowError(PayloadError);
    expect(() => guard.encode({ version: 1, step: 'hello world', action: 'c' })).toThrowError(
      PayloadError,
    );
    expect(() => guard.encode({ version: 1, step: 'a', action: '👍' })).toThrowError(PayloadError);
    expect(() => guard.encode({ version: 1, step: '', action: 'c' })).toThrowError(PayloadError);
    expect(() => guard.encode({ version: 1, step: 'a', action: '' })).toThrowError(PayloadError);
  });

  it('enforces the byte limit', () => {
    const tight = createInteractionGuard({ maxPayloadLength: 10 });
    expect(tight.encode({ version: 1, step: 'ab', action: 'cd' })).toBe('v1:ab:cd'); // 8 bytes
    expect(() => tight.encode({ version: 1, step: 'abcdefghi', action: 'cd' })).toThrowError(
      PayloadError,
    );
  });

  it('rejects invalid guard config at creation', () => {
    expect(() => createInteractionGuard({ delimiter: 'a' })).toThrowError(PayloadError);
    expect(() => createInteractionGuard({ delimiter: '::' })).toThrowError(PayloadError);
    expect(() => createInteractionGuard({ versionPrefix: '' })).toThrowError(PayloadError);
    expect(() => createInteractionGuard({ versionPrefix: 'v:1' })).toThrowError(PayloadError);
    expect(() => createInteractionGuard({ maxPayloadLength: 0 })).toThrowError(PayloadError);
    expect(() => createInteractionGuard({ maxPayloadLength: 2.5 })).toThrowError(PayloadError);
  });
});

describe('decode', () => {
  it.each([
    ['', 'empty'],
    ['nope', 'malformed'],
    ['v1:a', 'malformed'],
    ['v1:a:b:c', 'malformed'],
    ['x1:a:b', 'malformed'],
    ['vx:a:b', 'invalid_version'],
    ['v0:a:b', 'invalid_version'],
    ['v-1:a:b', 'invalid_version'],
    ['v1:a b:c', 'unsafe_token'],
    ['v1:a:👍', 'unsafe_token'],
    ['v1::c', 'unsafe_token'],
  ] as const)('classifies %j as %s', (raw, reason) => {
    expect(guard.decode(raw)).toEqual({ ok: false, reason });
  });

  it('rejects oversized ids', () => {
    const tight = createInteractionGuard({ maxPayloadLength: 8 });
    expect(tight.decode('v1:abc:de')).toEqual({ ok: false, reason: 'too_long' });
  });

  it('preserves case (steps/actions are case-sensitive)', () => {
    expect(guard.decode('v1:Step:Action')).toMatchObject({
      ok: true,
      payload: { step: 'Step', action: 'Action' },
    });
  });
});

/**
 * History-stack management: the trail of steps a session has visited.
 *
 * Invariant: the stack ends with the session's `currentStep`. Rewinding
 * truncates the stack to the target step and yields the pruned steps so
 * callers can drop the draft fields those steps owned.
 */

export type UnwindResult =
  | {
      readonly ok: true;
      readonly stack: readonly string[];
      /** Steps that were removed (positions after the target). */
      readonly prunedSteps: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'target_not_in_history' | 'stack_underflow';
    };

/**
 * Append a step to the trail. Consecutive duplicates collapse, so
 * re-rendering the same step (validation errors, retries) does not
 * grow the stack.
 */
export function pushStep(stack: readonly string[], step: string): readonly string[] {
  const last = stack.at(-1);
  if (last === step) {
    return stack;
  }
  return [...stack, step];
}

/**
 * Truncate the stack so it ends at `targetStep`. Uses the most recent
 * occurrence (`lastIndexOf`), so steps visited more than once unwind
 * to their latest position.
 */
export function unwindHistory(stack: readonly string[], targetStep: string): UnwindResult {
  const index = stack.lastIndexOf(targetStep);
  if (index === -1) {
    return { ok: false, reason: 'target_not_in_history' };
  }
  return {
    ok: true,
    stack: stack.slice(0, index + 1),
    prunedSteps: stack.slice(index + 1),
  };
}

/** Go back exactly one step (the classic "Back" button). */
export function popStep(stack: readonly string[]): UnwindResult {
  const previous = stack.at(-2);
  if (previous === undefined) {
    return { ok: false, reason: 'stack_underflow' };
  }
  return unwindHistory(stack, previous);
}

export interface PruneDraftOptions {
  /** Draft fields keyed by step name or `step:field` namespace. */
  readonly draft: Readonly<Record<string, unknown>>;
  /** Steps whose draft fields should be dropped (e.g. `rewind.prunedSteps`). */
  readonly unwoundSteps: readonly string[];
}

/**
 * Drop draft fields owned by unwound steps.
 *
 * Convention: a draft key belongs to step `S` when the key is exactly `S`
 * or starts with `S:` (e.g. `awaiting_slot` or `awaiting_slot:choice`).
 * Keys with no step prefix (e.g. `meta`) are always kept.
 *
 * Performs a shallow copy — values are referenced, not cloned.
 */
export function pruneDraft({ draft, unwoundSteps }: PruneDraftOptions): Record<string, unknown> {
  const pruned = new Set(unwoundSteps);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft)) {
    const colonIndex = key.indexOf(':');
    const stepName = colonIndex === -1 ? key : key.slice(0, colonIndex);
    if (pruned.has(key) || pruned.has(stepName)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

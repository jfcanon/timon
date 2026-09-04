/**
 * Collapse a burst of calls into one trailing run.
 *
 * A single voice phrase can land several broadcasts at once (the new task,
 * plus its parent whose subtask count moved). Reconciling once after the burst
 * costs one request instead of three, and never renders a half-applied state.
 */
export function debounce(fn: () => void, waitMs: number): {
  (): void;
  cancel: () => void;
} {
  let timer: number | undefined;
  const run = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      fn();
    }, waitMs);
  };
  run.cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return run;
}

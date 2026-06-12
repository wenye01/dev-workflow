export const DEFAULT_MAX_FIX_ROUNDS = 1;
export const DEFAULT_MAX_EVALUATOR_RETRIES = 1;

export function normalizeBudget(
  value: unknown,
  fallback: number,
): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : fallback;
}

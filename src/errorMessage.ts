/**
 * Narrow an unknown caught value to a human-readable message string. `catch`
 * binds `unknown`, so every error-reporting path needs this same reduction;
 * keeping it in one place means improvements (unwrapping `cause` chains,
 * AggregateError, etc.) land everywhere at once.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

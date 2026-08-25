/**
 * Duplicate-key errors are detected structurally rather than with `instanceof
 * MongoServerError`. npm can install more than one copy of the `mongodb` driver
 * (mongoose carries its own nested copy), and `instanceof` is false across copies —
 * which silently turned every duplicate-key 409 into a raw 500.
 */
export interface DuplicateKeyError {
  code: 11000;
  keyValue?: Record<string, unknown>;
  message: string;
}

export function isDuplicateKeyError(error: unknown): error is DuplicateKeyError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/** True when the duplicate collided on the given key, e.g. '_id' or 'rollNo'. */
export function duplicateKeyIncludes(error: DuplicateKeyError, key: string): boolean {
  return Object.keys(error.keyValue ?? {}).includes(key);
}

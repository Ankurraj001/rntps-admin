import { env } from '../config/env.js';

/**
 * Builds the `plaintextPassword` part of an update, so every place that sets a password
 * records the readable copy the same way — and so turning the feature off actively
 * clears the stored value rather than leaving stale passwords behind.
 *
 * This exists because the school asked to be able to read a teacher's password back to
 * them. Authentication never touches this field; `passwordHash` remains the only thing
 * verified against. See STORE_PLAINTEXT_PASSWORDS in config/env.ts for the tradeoff.
 */
export function plaintextFieldFor(password: string): { plaintextPassword: string | null } {
  return { plaintextPassword: env.STORE_PLAINTEXT_PASSWORDS ? password : null };
}

export const isPlaintextStorageEnabled = (): boolean => env.STORE_PLAINTEXT_PASSWORDS;

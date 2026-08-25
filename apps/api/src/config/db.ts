import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);
// Reject documents containing keys the schema does not declare, rather than silently dropping them.
mongoose.set('strict', 'throw');

let connectionPromise: Promise<typeof mongoose> | null = null;
let listenersAttached = false;

export interface ConnectOptions {
  uri?: string;
  /**
   * Serverless invocations each hold their own pool, so a small cap keeps a burst of
   * warm containers from exhausting Atlas's connection limit. A long-lived server can
   * afford the driver default.
   */
  maxPoolSize?: number;
}

function attachListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;
  mongoose.connection.on('connected', () => logger.info('mongodb connected'));
  mongoose.connection.on('disconnected', () => logger.warn('mongodb disconnected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'mongodb error'));
}

/**
 * Connects, or reuses the existing connection.
 *
 * The promise is cached at module scope so that on Netlify a warm function container
 * reuses one pool across invocations. Without this, every request opens a new pool and
 * Atlas starts refusing connections — the classic serverless/Mongoose failure.
 */
export async function connectDatabase(options: ConnectOptions = {}): Promise<void> {
  if (mongoose.connection.readyState === 1) return;

  attachListeners();

  if (!connectionPromise) {
    connectionPromise = mongoose
      .connect(options.uri ?? env.MONGODB_URI, {
        serverSelectionTimeoutMS: 8_000,
        autoIndex: env.NODE_ENV !== 'production',
        ...(options.maxPoolSize ? { maxPoolSize: options.maxPoolSize } : {}),
      })
      .catch((error: unknown) => {
        // Clear the cache so the next invocation retries instead of replaying the failure.
        connectionPromise = null;
        throw error;
      });
  }

  await connectionPromise;
}

export async function disconnectDatabase(): Promise<void> {
  connectionPromise = null;
  await mongoose.connection.close();
}

export function isDatabaseReady(): boolean {
  return mongoose.connection.readyState === 1;
}

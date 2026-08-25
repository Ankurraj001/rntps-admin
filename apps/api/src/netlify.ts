import type { APIGatewayProxyEvent, Handler } from 'aws-lambda';
import serverless from 'serverless-http';
import { createApp } from './app.js';
import { connectDatabase } from './config/db.js';
import { logger } from './config/logger.js';

/**
 * Small pool per container: on Netlify each warm Lambda holds its own pool, so a burst
 * of containers multiplies connections against Atlas's cap.
 */
const SERVERLESS_MAX_POOL_SIZE = 5;

const FUNCTION_PREFIX = '/.netlify/functions/api';

/**
 * Netlify may hand the function either the original request path (`/api/v1/students`)
 * or the rewritten function path (`/.netlify/functions/api/v1/students`), depending on
 * how the rewrite resolves. Both are normalised back to the `/api/...` path Express
 * actually routes on, so routing does not depend on that detail.
 */
export function normaliseFunctionPath(rawPath: string | undefined | null): string {
  const path = rawPath && rawPath.length > 0 ? rawPath : '/';

  const rest = path.startsWith(FUNCTION_PREFIX)
    ? path.slice(FUNCTION_PREFIX.length)
    : path.startsWith('/api')
      ? path.slice('/api'.length)
      : path;

  if (!rest || rest === '/') return '/api';
  return `/api${rest.startsWith('/') ? rest : `/${rest}`}`;
}

// Built once per container, then reused by every warm invocation.
const serverlessApp = serverless(createApp(), { binary: ['application/pdf'] });

export const handler: Handler = async (event: APIGatewayProxyEvent, context) => {
  // Without this the container is torn down before the pooled sockets are reused.
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    await connectDatabase({ maxPoolSize: SERVERLESS_MAX_POOL_SIZE });
  } catch (error) {
    logger.error({ err: error }, 'database unavailable');
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { code: 'DB_UNAVAILABLE', message: 'Database is unavailable' } }),
    };
  }

  return serverlessApp({ ...event, path: normaliseFunctionPath(event.path) }, context);
};

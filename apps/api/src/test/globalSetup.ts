import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

/**
 * Starts ONE in-memory mongod for the entire run and shares its URI with every test
 * file.
 *
 * Previously each file started its own, so a full run spun up eleven mongod processes.
 * That was slower and made individual tests time out intermittently under the resulting
 * contention. Each file still gets its own database on this shared instance, so they
 * remain isolated.
 */
let mongo: MongoMemoryServer | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  mongo = await MongoMemoryServer.create();
  project.provide('mongoUri', mongo.getUri());

  return async () => {
    await mongo?.stop();
  };
}

declare module 'vitest' {
  interface ProvidedContext {
    mongoUri: string;
  }
}

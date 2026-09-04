import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, inject } from 'vitest';

// Imported for their side effect of registering the schemas, so their collections and
// indexes can be created before any test runs.
import '../models/Attendance.js';
import '../models/AuditLog.js';
import '../models/Expense.js';
import '../models/FeeStructure.js';
import '../models/Invoice.js';
import '../models/Notification.js';
import '../models/Settings.js';
import '../models/Student.js';
import '../models/User.js';

/**
 * Connects to the shared in-memory mongod started by globalSetup, using a database name
 * unique to this file so parallel test files cannot see each other's data.
 *
 * No replica set is needed: every write in this system targets a single document.
 */
const databaseName = `rntps-test-${randomUUID()}`;

beforeAll(async () => {
  await mongoose.connect(inject('mongoUri'), { dbName: databaseName });

  // Mongoose creates collections and builds indexes lazily and in the background, so
  // without this the first test to rely on a unique index can run before that index
  // exists and fail intermittently.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.createCollection().catch(() => undefined)),
  );
});

afterEach(async () => {
  // Documents only — indexes are left in place, so they are built once per file.
  const collections = await mongoose.connection.db?.collections();
  for (const collection of collections ?? []) {
    await collection.deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../config/logger.js';

/**
 * Reports what the database actually weighs, per collection, against the Atlas M0 budget.
 *
 * Written because capacity here was being estimated rather than measured. The estimates
 * were wrong in both directions: `notifications` was far heavier per document than a
 * glance at the schema suggests (a percent-encoded `wa.me` URL triples the fee slip it
 * carries), while `auditLogs` was far lighter (most call sites record a summary, not a
 * before/after snapshot).
 *
 * Two numbers matter more than the totals:
 *
 * - **Indexes that exist.** `connectDatabase` sets `autoIndex: false` in production, so the
 *   indexes declared in the schemas are only real once `npm run indexes:sync` has run.
 *   A missing index means a collection scan; a missing *TTL* index means a collection that
 *   was designed to expire never does. Both are invisible without looking.
 * - **`accesses.ops` per index.** An index nobody queries still costs storage and slows
 *   every write. Zero ops since the last restart is the signal to consider dropping it.
 *
 * Atlas enforces the M0 limit against *logical* size, which is what this reports — so do
 * not discount these figures for WiredTiger compression.
 *
 * Run with `npm run db:stats --workspace @rntps/api`. Read-only; safe against production.
 */

/** Atlas M0's ceiling. Free-tier storage is 512 MB, not 512 GB. */
const M0_BUDGET_BYTES = 512 * 1024 * 1024;

/** Warn at 80%: enough runway left to migrate deliberately rather than in a hurry. */
const WARN_FRACTION = 0.8;

interface StorageStats {
  count: number;
  size: number;
  avgObjSize?: number;
  totalIndexSize: number;
  indexSizes: Record<string, number>;
}

interface IndexReport {
  name: string;
  mb: string;
  ops: number | null;
  ttlDays: number | null;
}

interface CollectionReport {
  collection: string;
  count: number;
  avgObjSize: number;
  dataMB: number;
  indexMB: number;
  totalMB: number;
  indexes: IndexReport[];
}

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 100) / 100;

async function main(): Promise<void> {
  await connectDatabase();

  const db = mongoose.connection.db;
  if (!db) throw new Error('not connected');

  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  const reports: CollectionReport[] = [];

  for (const { name } of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    const collection = db.collection(name);

    const [stats] = await collection
      .aggregate<{ storageStats: StorageStats }>([{ $collStats: { storageStats: {} } }])
      .toArray();
    if (!stats) continue;
    const { count, size, avgObjSize, totalIndexSize, indexSizes } = stats.storageStats;

    // $indexStats counts operations since the server last restarted, so a low number on a
    // young process means "not yet used", not "unused". Treat it as a hint, not a verdict.
    const opsByIndex = new Map<string, number>();
    try {
      const usage = await collection
        .aggregate<{ name: string; accesses: { ops: number } }>([{ $indexStats: {} }])
        .toArray();
      for (const entry of usage) opsByIndex.set(entry.name, entry.accesses.ops);
    } catch (error) {
      logger.warn({ err: error, collection: name }, '$indexStats unavailable — index usage omitted');
    }

    const specs = await collection.indexes();
    const indexes: IndexReport[] = specs.map((spec) => {
      const indexName = String(spec.name);
      const expireAfterSeconds = spec.expireAfterSeconds as number | undefined;
      return {
        name: indexName,
        mb: (mb(indexSizes[indexName] ?? 0)).toFixed(2),
        ops: opsByIndex.get(indexName) ?? null,
        ttlDays: typeof expireAfterSeconds === 'number' ? Math.round(expireAfterSeconds / 86_400) : null,
      };
    });

    reports.push({
      collection: name,
      count,
      avgObjSize: avgObjSize ?? 0,
      dataMB: mb(size),
      indexMB: mb(totalIndexSize),
      totalMB: mb(size + totalIndexSize),
      indexes,
    });
  }

  // Biggest first: the top two or three are the only ones worth optimising.
  reports.sort((a, b) => b.totalMB - a.totalMB);

  for (const report of reports) {
    logger.info(
      {
        count: report.count,
        avgObjSize: report.avgObjSize,
        dataMB: report.dataMB,
        indexMB: report.indexMB,
        totalMB: report.totalMB,
        indexes: report.indexes,
      },
      `${report.collection} — ${report.totalMB} MB`,
    );
  }

  const usedBytes = reports.reduce((sum, r) => sum + (r.dataMB + r.indexMB) * 1024 * 1024, 0);
  const usedFraction = usedBytes / M0_BUDGET_BYTES;

  // A collection holding only `_id_` when its schema declares more is the signature of
  // indexes:sync never having run — worth saying out loud rather than leaving in the table.
  const unindexed = reports.filter((r) => r.count > 0 && r.indexes.length === 1);
  if (unindexed.length > 0) {
    logger.warn(
      { collections: unindexed.map((r) => r.collection) },
      'these collections have only their _id index — has `npm run indexes:sync` ever run here?',
    );
  }

  const ttls = reports.flatMap((r) =>
    r.indexes.filter((i) => i.ttlDays !== null).map((i) => `${r.collection}.${i.name} (${i.ttlDays}d)`),
  );
  logger.info(
    { ttlIndexes: ttls },
    ttls.length > 0 ? 'TTL indexes in place' : 'no TTL index exists — nothing in this database expires',
  );

  const summary = {
    collections: reports.length,
    usedMB: mb(usedBytes),
    budgetMB: mb(M0_BUDGET_BYTES),
    percentUsed: Math.round(usedFraction * 1000) / 10,
    largest: reports.slice(0, 3).map((r) => `${r.collection} ${r.totalMB}MB`),
  };

  if (usedFraction >= WARN_FRACTION) {
    logger.warn(summary, `over ${WARN_FRACTION * 100}% of the M0 budget — plan a migration`);
  } else {
    logger.info(summary, `${summary.percentUsed}% of the 512 MB M0 budget used`);
  }
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'db stats failed');
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());

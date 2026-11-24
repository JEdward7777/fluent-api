import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

import type { DbTransaction } from '@/lib/types';

import * as schema from '@/db/schema';

import type { DatabaseProof, IdentityTransaction } from './license-database-identity';
import type { LicenseDatabaseAdapter } from './license-database.types';

import { effectiveLicenseStatus } from '../license-impact';
import * as repo from './license-classifications.repository';
import {
  availableLicenseRelation,
  issueLicenseChallenge,
  proveLicenseDatabase,
} from './license-database-identity';
import { licenseSyncGuidance } from './license-sync-policy';

export function getClassifications(tx?: DbTransaction) {
  return repo.getClassifications(tx);
}

export function createLicenseDatabaseAdapter(): LicenseDatabaseAdapter {
  return {
    load: () => repo.loadClassificationSnapshot(),
    apply: (artifact, replace, publish, force, policy, identity) =>
      repo.applyClassifications(artifact, replace, publish, force, policy, undefined, identity),
  };
}

/** The local workbench owns this connection and closes it with the workflow. */
export function createOwnedLicenseDatabaseAdapter(
  databaseUrl: string,
  password?: () => string,
  role: 'source' | 'destination' = 'destination'
): LicenseDatabaseAdapter {
  const connect = (keepPreviewSession = false) =>
    postgres(databaseUrl, {
      max: 1,
      // Loaded source and previewed target sessions persist until their owner closes
      // or replaces the single-slot pools. No transaction or lock remains open while reviewing.
      idle_timeout: keepPreviewSession ? 0 : 20,
      ...(keepPreviewSession ? { max_lifetime: 0 } : {}),
      connect_timeout: 5,
      ...(password ? { password } : {}),
    });
  const client = connect(role === 'destination');
  const database = drizzle(client, { schema });
  // A CLI workflow can use one adapter for both roles. Its source challenge must
  // run on the Load backend while the destination holds a different transaction.
  let sourceClient: ReturnType<typeof connect> | undefined;
  const sourcePool = () => (sourceClient ??= connect(true));
  const probe = async (
    task: (tx: IdentityTransaction) => Promise<DatabaseProof>,
    loadedSource = false
  ) => {
    const pinned = loadedSource ? sourcePool() : connect();
    const timer = setTimeout(() => {
      if (pinned === sourceClient) sourceClient = undefined;
      void pinned.end({ timeout: 0 });
    }, 7500);
    try {
      return await drizzle(pinned, { schema }).transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
        await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '8s'`);
        return task(tx);
      });
    } finally {
      clearTimeout(timer);
      if (!loadedSource) await pinned.end({ timeout: 1 });
    }
  };
  const loadSnapshot = async (tx: IdentityTransaction) => {
    const snapshot = await repo.loadClassificationSnapshot(tx, console);
    if (snapshot.tableExists) snapshot.relation = await availableLicenseRelation(tx);
    return snapshot;
  };
  return {
    loadSource: () =>
      drizzle(sourcePool(), { schema }).transaction(async (tx) => {
        // A restricted source can still be loaded for conservative sync.
        const sourceMarker = await tx
          .transaction(async (mark) => {
            const nonce = randomUUID();
            await mark.execute(
              sql`SELECT set_config('fluent.license_loaded_source', ${nonce}, false)`
            );
            return nonce;
          })
          .catch(() => undefined);
        return { ...(await loadSnapshot(tx)), sourceMarker };
      }),
    challenge: (sourceMarker) => async (observe) => {
      if (!sourceMarker) return { mode: 'unavailable' };
      return probe(async (tx) => {
        const [row] = await tx.execute<{ marker: string | null }>(
          sql`SELECT current_setting('fluent.license_loaded_source', true) AS marker`
        );
        if (row.marker !== sourceMarker) return { mode: 'unavailable' };
        return issueLicenseChallenge(tx, observe);
      }, true);
    },
    prove: (challenge) =>
      probe((tx) => proveLicenseDatabase(tx, challenge)).catch(() => ({
        mode: 'unavailable' as const,
      })),
    inspectTarget: (challenge) =>
      database.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '6s'`);
        const marker = randomUUID();
        await tx.execute(sql`SELECT set_config('fluent.license_target_preview', ${marker}, false)`);
        const snapshot = await loadSnapshot(tx);
        const proof = challenge ? await proveLicenseDatabase(tx, challenge) : undefined;
        return { snapshot, proof, marker };
      }),
    load: (selected) =>
      (selected === 'source' ? drizzle(sourcePool(), { schema }) : database).transaction(
        loadSnapshot
      ),
    apply: (artifact, replace, beforeCommit, force, expectedPolicy, identity) =>
      repo.applyClassifications(
        artifact,
        replace,
        beforeCommit,
        force,
        expectedPolicy,
        database,
        identity
      ),
    close: async () => {
      await Promise.all([client.end({ timeout: 5 }), sourceClient?.end({ timeout: 5 })]);
    },
  };
}

export async function getSyncGuidance() {
  const snapshot = await repo.loadClassificationSnapshot();
  const known = new Map(snapshot.classifications.map((row) => [row.normalizedText, row.status]));
  const rows = snapshot.context.resources.filter((row) => row.provider === 'dbl');
  const missing = new Set(
    rows
      .map((row) => effectiveLicenseStatus(row.rawNotice, known))
      .filter((row) => row.missingClassification)
      .map((row) => row.normalizedText)
  );
  return licenseSyncGuidance(
    rows.filter((row) => row.ttsLicenseStatus === 'unknown').length,
    missing.size,
    known.size === 0,
    snapshot.classifications.filter((row) => row.status === 'unknown').length
  );
}

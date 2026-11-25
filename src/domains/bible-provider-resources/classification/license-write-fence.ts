import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { hashCanonicalJson } from '@/lib/llm/canonical-json';

import type { IdentityTransaction } from './license-database-identity';

import {
  availableLicenseRelation,
  issueLicenseChallenge,
  proveLicenseDatabase,
  sameLicenseRelation,
} from './license-database-identity';

export type TargetMatch = 'prior' | 'planned' | 'both' | 'other' | 'unverified';
export type DatabaseFence = (checkFiles: () => Promise<void>) => Promise<TargetMatch>;
type Transaction = <T>(work: (tx: IdentityTransaction) => Promise<T>) => Promise<T>;

export function targetMatch(prior: boolean, planned: boolean): TargetMatch {
  if (prior && planned) return 'both';
  if (prior) return 'prior';
  return planned ? 'planned' : 'other';
}

export async function lockClassificationWriter(tx: IdentityTransaction) {
  await tx.execute(sql`LOCK TABLE license_classifications IN SHARE ROW EXCLUSIVE MODE`);
}

async function policyHash(tx: IdentityTransaction) {
  const rows = await tx.execute<{ contents: string }>(
    sql`SELECT to_jsonb(c)::text AS contents FROM license_classifications c ORDER BY normalized_text COLLATE "C"`
  );
  return hashCanonicalJson(rows.map((row) => row.contents));
}

/** Bind an independent observer to the actual locked writer before COMMIT can be sent. */
export async function prepareLicenseFence(writer: IdentityTransaction, witness: Transaction) {
  const marker = randomUUID();
  const proof = await proveLicenseDatabase(writer, (observe) =>
    witness(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      await tx.execute(sql`SELECT set_config('fluent.license_fence', ${marker}, false)`);
      return issueLicenseChallenge(tx, observe);
    })
  );
  if (proof.mode !== 'same') return undefined;
  const prior = await policyHash(writer);
  return async (): Promise<DatabaseFence> => {
    const planned = await policyHash(writer);
    return (checkFiles) =>
      witness(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
        const [row] = await tx.execute<{ marker: string | null }>(
          sql`SELECT current_setting('fluent.license_fence', true) AS marker`
        );
        if (row.marker !== marker) return 'unverified';
        await lockClassificationWriter(tx);
        if (!sameLicenseRelation(await availableLicenseRelation(tx), proof.target))
          return 'unverified';
        const actual = await policyHash(tx);
        await checkFiles();
        return targetMatch(actual === prior, actual === planned);
      });
  };
}

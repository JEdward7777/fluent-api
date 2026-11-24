import { sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';

export type IdentityTransaction = Parameters<
  Parameters<typeof import('@/db').db.transaction>[0]
>[0];

export interface LicenseRelation {
  database: string;
  relation: string;
  schema: string;
}

interface Challenge {
  relation: LicenseRelation;
  pid: number;
  first: number;
  second: number;
}

export type ChallengeConnection = (
  observe: (challenge: Challenge) => Promise<DatabaseProof>
) => Promise<DatabaseProof>;

export interface DatabaseProof {
  mode: 'same' | 'distinct' | 'unavailable';
  source?: LicenseRelation;
  target?: LicenseRelation;
}

export async function readLicenseRelation(tx: IdentityTransaction): Promise<LicenseRelation> {
  const [row] = await tx.execute<{ database: string; relation: string; schema: string }>(sql`
    SELECT d.oid::text AS database, c.oid::text AS relation, n.nspname AS schema
    FROM pg_database d, pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE d.datname = current_database() AND c.oid = 'license_classifications'::regclass
  `);
  return { database: row.database, relation: row.relation, schema: row.schema };
}

export function sameLicenseRelation(left?: LicenseRelation | null, right?: LicenseRelation | null) {
  return (
    left?.database === right?.database &&
    left?.schema === right?.schema &&
    left?.relation === right?.relation
  );
}

export function sameDatabaseProof(left: DatabaseProof, right: DatabaseProof) {
  return (
    left.mode === right.mode &&
    sameLicenseRelation(left.source, right.source) &&
    sameLicenseRelation(left.target, right.target)
  );
}

export async function availableLicenseRelation(tx: IdentityTransaction) {
  // Restricted metadata visibility must not abort the caller's data transaction.
  try {
    return await tx.transaction(readLicenseRelation);
  } catch {
    return null;
  }
}

export async function issueLicenseChallenge(
  tx: IdentityTransaction,
  observe: Parameters<ChallengeConnection>[0]
) {
  const first = randomInt(0x80000000);
  const second = randomInt(0x80000000);
  const relation = await readLicenseRelation(tx);
  const [lock] = await tx.execute<{ locked: boolean; pid: number }>(sql`
    SELECT pg_try_advisory_xact_lock(${first}::int, ${second}::int) AS locked, pg_backend_pid() AS pid
  `);
  if (!lock.locked) throw new Error('Identity challenge unavailable');
  return observe({ relation, first, second, pid: lock.pid });
}

export async function proveLicenseDatabase(
  tx: IdentityTransaction,
  challenge?: ChallengeConnection
): Promise<DatabaseProof> {
  if (!challenge) return { mode: 'unavailable' };
  try {
    // A permission error in this optional probe must leave the writer transaction usable.
    return await tx.transaction(async (probe) => {
      const target = await readLicenseRelation(probe);
      return challenge(async ({ relation: source, first, second, pid }) => {
        if (!sameLicenseRelation(source, target)) return { mode: 'distinct', source, target };
        const [lock] = await probe.execute<{ visible: boolean }>(sql`
          SELECT EXISTS (SELECT FROM pg_locks WHERE locktype = 'advisory'
            AND database = ${target.database}::oid AND pid = ${pid}
            AND classid = ${first}::oid AND objid = ${second}::oid AND objsubid = 2
            AND granted AND mode = 'ExclusiveLock') AS visible
        `);
        return { mode: lock.visible ? 'same' : 'distinct', source, target };
      });
    });
  } catch {
    return { mode: 'unavailable' };
  }
}

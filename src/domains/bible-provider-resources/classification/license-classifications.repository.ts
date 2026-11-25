import { and, eq, or, sql } from 'drizzle-orm';

import type { DbTransaction } from '@/lib/types';

import { bible_provider_resources, bibles, license_classifications } from '@/db/schema';
import { hashCanonicalJson } from '@/lib/llm/canonical-json';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { IdentityTransaction } from './license-database-identity';
import type {
  LicenseDatabaseAdapter,
  LicenseDatabaseSnapshot,
  StoredLicenseClassification,
} from './license-database.types';

import { catalogLicenseNotices, indexLicenseNoticeExamples } from '../license-normalizer';
import {
  availableLicenseRelation,
  proveLicenseDatabase,
  sameDatabaseProof,
  sameLicenseRelation,
} from './license-database-identity';
import { selectLicenseMaintenanceRows } from './license-database-projection';
import { LicenseDatabaseAbortedError, LicensePolicyDriftError } from './license-database.types';
import { comparableCatalog } from './license-freshness';
import { readStoredLicenseClassification } from './license-stored-decision';
import { lockClassificationWriter, prepareLicenseFence } from './license-write-fence';

type LicenseDb = typeof import('@/db').db;

export async function getClassifications(tx?: DbTransaction | LicenseDb) {
  const connection = tx ?? (await import('@/db')).db;
  return connection.select().from(license_classifications);
}

export async function loadClassificationSnapshot(
  database?: LicenseDb | DbTransaction,
  logging?: Pick<typeof import('@/lib/logger').logger, 'warn'>
): Promise<LicenseDatabaseSnapshot> {
  const connection = database ?? (await import('@/db')).db;
  const [exists] = await connection
    .select({ exists: sql<boolean>`to_regclass('license_classifications') IS NOT NULL` })
    .from(sql`(SELECT 1) AS existence_probe`);
  const [rows, resources] = await Promise.all([
    exists.exists ? getClassifications(connection) : Promise.resolve([]),
    connection
      .select({
        provider: bible_provider_resources.provider,
        externalId: bible_provider_resources.externalId,
        bibleId: bibles.id,
        name: bibles.name,
        abbreviation: bibles.abbreviation,
        rawNotice: bible_provider_resources.textLicenseNotice,
        ttsLicenseStatus: bible_provider_resources.ttsLicenseStatus,
      })
      .from(bible_provider_resources)
      .innerJoin(
        bibles,
        and(
          sql`${bibles.provider}::text = ${bible_provider_resources.provider}::text`,
          eq(bibles.externalId, bible_provider_resources.externalId)
        )
      ),
  ]);
  const logger = logging ?? (await import('@/lib/logger')).logger;
  const examples = indexLicenseNoticeExamples(catalogLicenseNotices(resources));
  const classifications = rows.map((row) => {
    const stored = readStoredLicenseClassification(row, logger);
    const example = examples.get(row.normalizedText);
    if (example !== undefined) stored.exampleNotice = example;
    return stored;
  });
  return {
    tableExists: exists.exists,
    classifications,
    context: {
      label: 'Current database text catalog',
      resources,
      projection: 'classification-only',
    },
  };
}

/** Whole-set replacement is table-scoped; unchanged rows retain all timestamps. */
export async function applyClassifications(
  artifact: LicenseArtifact,
  replace: boolean,
  beforeCommit?: () => Promise<void>,
  _force = false,
  expectedPolicy?: StoredLicenseClassification[],
  database?: LicenseDb,
  identity?: Parameters<LicenseDatabaseAdapter['apply']>[5],
  witness?: Parameters<typeof prepareLicenseFence>[1]
) {
  const connection = database ?? (await import('@/db')).db;
  let phase: 'checking' | 'writing' | 'closed' = 'checking';
  const stage = async (tx: IdentityTransaction) => {
    if (identity) {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
      await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '6s'`);
      if (identity.marker) {
        const [row] = await tx.execute<{ marker: string | null }>(
          sql`SELECT current_setting('fluent.license_target_preview', true) AS marker`
        );
        if (row.marker !== identity.marker)
          throw new LicensePolicyDriftError(
            'The previewed database connection changed since preview; prepare a new preview'
          );
      }
      await lockClassificationWriter(tx);
      if (
        identity.target !== undefined &&
        !sameLicenseRelation(await availableLicenseRelation(tx), identity.target)
      )
        throw new LicensePolicyDriftError(
          'The database target or its identity proof changed since preview; prepare a new preview'
        );
      if (
        identity.expected &&
        !sameDatabaseProof(await proveLicenseDatabase(tx, identity.challenge), identity.expected)
      )
        throw new LicensePolicyDriftError(
          'The database target or its identity proof changed since preview; prepare a new preview'
        );
    }
    // Serialize initialization/replacement with ordinary table writes, including the
    // empty-table case where no row exists to lock. This enforces --force at apply.
    if (!identity && (replace || expectedPolicy)) await lockClassificationWriter(tx);
    const existing = new Map(
      (await getClassifications(tx)).map((row) => [row.normalizedText, row])
    );
    if (expectedPolicy) {
      const expected = new Map(expectedPolicy.map((row) => [row.normalizedText, row]));
      const matches =
        existing.size === expected.size &&
        [...existing].every(([key, row]) => {
          const prior = expected.get(key);
          return (
            prior &&
            row.status === prior.status &&
            row.classifiedBy === prior.classifiedBy &&
            row.reviewedAt?.toISOString() === (prior.reviewedAt ?? undefined) &&
            row.reviewState === (prior.reviewState ?? 'unreviewed') &&
            (row.decisionAt?.toISOString() ?? null) === (prior.decisionAt ?? null) &&
            row.reviewedBy === (prior.reviewedBy ?? null) &&
            (row.humanReviewedAt?.toISOString() ?? null) === (prior.humanReviewedAt ?? null) &&
            hashCanonicalJson(row.rationale) ===
              hashCanonicalJson(
                prior.storedRationale === undefined ? prior.rationale : prior.storedRationale
              )
          );
        });
      if (!matches) throw new LicensePolicyDriftError();
    }
    if (identity?.expectedContext) {
      const current = await loadClassificationSnapshot(tx, console);
      if (
        JSON.stringify(comparableCatalog(current.context)) !==
        JSON.stringify(comparableCatalog(identity.expectedContext))
      )
        throw new LicensePolicyDriftError(
          'Database catalog changed since preview; prepare a new preview'
        );
    }
    const capture =
      identity?.registerFence && witness ? await prepareLicenseFence(tx, witness) : undefined;
    // Both overwrite and sync are scoped upserts. The plan supplies only selected keys.
    const selectedExisting = artifact.classifications.flatMap(({ normalizedText }) => {
      const row = existing.get(normalizedText);
      return row ? [readStoredLicenseClassification(row)] : [];
    });
    const rows = selectLicenseMaintenanceRows(artifact, selectedExisting);
    // A rejected transaction can never resume past preflight and issue a late write.
    if (phase === 'closed') throw new Error('The Save transaction already ended');
    phase = 'writing';
    // Bounded batches reduce parameter pressure; the transaction preserves all-or-nothing writes.
    for (let offset = 0; offset < rows.length; offset += 100) {
      await tx
        .insert(license_classifications)
        .values(rows.slice(offset, offset + 100))
        .onConflictDoUpdate({
          target: license_classifications.normalizedText,
          set: {
            status: sql`excluded.status`,
            rationale: sql`excluded.rationale`,
            classifiedBy: sql`excluded.classified_by`,
            reviewState: sql`excluded.review_state`,
            decisionAt: sql`excluded.decision_at`,
            reviewedBy: sql`excluded.reviewed_by`,
            humanReviewedAt: sql`excluded.human_reviewed_at`,
          },
          setWhere: or(
            sql`${license_classifications.status} IS DISTINCT FROM excluded.status`,
            sql`${license_classifications.rationale} IS DISTINCT FROM excluded.rationale`,
            sql`${license_classifications.classifiedBy} IS DISTINCT FROM excluded.classified_by`,
            sql`${license_classifications.reviewState} IS DISTINCT FROM excluded.review_state`,
            sql`${license_classifications.decisionAt} IS DISTINCT FROM excluded.decision_at`,
            sql`${license_classifications.reviewedBy} IS DISTINCT FROM excluded.reviewed_by`,
            sql`${license_classifications.humanReviewedAt} IS DISTINCT FROM excluded.human_reviewed_at`
          ),
        });
    }
    if (capture) identity?.registerFence?.(await capture());
    await beforeCommit?.();
  };
  await connection
    .transaction(async (tx) => {
      try {
        await stage(tx);
      } catch (cause) {
        // postgres-js rethrows this callback error only after its ROLLBACK succeeds.
        // Lost connections and failed COMMIT acknowledgements reject separately.
        if (identity?.registerFence) throw new LicenseDatabaseAbortedError(cause);
        throw cause;
      }
    })
    .catch((cause: unknown) => {
      const beforeMutation = phase === 'checking';
      phase = 'closed';
      if (
        beforeMutation &&
        identity?.registerFence &&
        !(cause instanceof LicenseDatabaseAbortedError)
      )
        throw new LicenseDatabaseAbortedError(cause);
      throw cause;
    });
}

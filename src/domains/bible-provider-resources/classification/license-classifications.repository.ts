import { and, eq, or, sql } from 'drizzle-orm';

import type { DbTransaction } from '@/lib/types';

import { bible_provider_resources, bibles, license_classifications } from '@/db/schema';
import { hashCanonicalJson } from '@/lib/llm/canonical-json';

import type { LicenseArtifact, LicenseClassification } from '../license-artifact.schemas';
import type {
  LicenseDatabaseSnapshot,
  StoredLicenseClassification,
} from './license-database.types';

import { licenseArtifactSchema, licenseClassificationSchema } from '../license-artifact.schemas';
import {
  licenseDatabaseProjection,
  licenseRationaleText,
  selectLicenseMaintenanceRows,
} from './license-database-projection';
import { LicensePolicyDriftError } from './license-database.types';

type LicenseDb = typeof import('@/db').db;

export async function getClassifications(tx?: DbTransaction | LicenseDb) {
  const connection = tx ?? (await import('@/db')).db;
  return connection.select().from(license_classifications);
}

export async function loadClassificationSnapshot(
  database?: LicenseDb,
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
  const classifications: StoredLicenseClassification[] = rows.map((row) => {
    const content = row.rationale;
    // Existing card rows may contain only a rationale; model/human evidence is optional.
    const text = licenseRationaleText(content);
    const metadata =
      content && typeof content === 'object' && !Array.isArray(content) ? content : {};
    const evidence = licenseClassificationSchema.safeParse(metadata.evidence);
    const run = licenseArtifactSchema.shape.classificationRun.safeParse(metadata.classificationRun);
    const contract = evidence.success
      ? (evidence.data.evidenceContract ?? (run.success ? run.data : undefined))
      : undefined;
    const expectedProducer = !evidence.success
      ? null
      : evidence.data.source === 'manual'
        ? 'human'
        : evidence.data.source === 'rule'
          ? `rule:${evidence.data.rule?.id}`
          : evidence.data.source === 'gemini'
            ? contract?.models
                .map((model) => `${model.provider}:${model.model}`)
                .sort()
                .join(',')
            : 'table';
    const usableEvidence =
      row.classifiedBy === expectedProducer &&
      evidence.success &&
      (run.success || (!evidence.data.samples.length && !evidence.data.rule)) &&
      evidence.data.status === row.status &&
      evidence.data.rationale === text &&
      evidence.data.normalizedText === row.normalizedText &&
      (evidence.data.reviewState === undefined ||
        (evidence.data.reviewState === row.reviewState &&
          (evidence.data.decisionAt ?? null) === (row.decisionAt?.toISOString() ?? null) &&
          (evidence.data.reviewedBy ?? null) === row.reviewedBy &&
          (evidence.data.humanReviewedAt ?? null) ===
            (row.humanReviewedAt?.toISOString() ?? null)));
    if (metadata.evidence !== undefined && !usableEvidence)
      logger.warn({
        normalizedText: row.normalizedText,
        classifiedBy: row.classifiedBy,
        message:
          'Stored provenance does not match the current database decision; retaining exact table authority without stale evidence',
      });
    const evidenceRow = usableEvidence
      ? {
          ...(structuredClone(metadata.evidence) as LicenseClassification),
          reviewState:
            evidence.data.reviewState ??
            (evidence.data.source === 'gemini' ? 'llm_reviewed' : 'unreviewed'),
          decisionAt: evidence.data.decisionAt ?? null,
          reviewedBy: evidence.data.reviewedBy ?? null,
          humanReviewedAt: evidence.data.humanReviewedAt ?? null,
        }
      : null;
    return {
      ...(usableEvidence
        ? {
            evidence: structuredClone(evidenceRow) as LicenseClassification,
            ...(run.success
              ? {
                  classificationRun: structuredClone(
                    metadata.classificationRun
                  ) as LicenseArtifact['classificationRun'],
                }
              : {}),
          }
        : {}),
      storedRationale: structuredClone(content),
      normalizedText: row.normalizedText,
      status: row.status,
      rationale: text || 'No recorded rationale',
      classifiedBy: row.classifiedBy,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewState: row.reviewState,
      decisionAt: row.decisionAt?.toISOString() ?? null,
      reviewedBy: row.reviewedBy,
      humanReviewedAt: row.humanReviewedAt?.toISOString() ?? null,
    };
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
  database?: LicenseDb
) {
  const connection = database ?? (await import('@/db')).db;
  const proposed = licenseDatabaseProjection(artifact);
  await connection.transaction(async (tx) => {
    // Serialize initialization/replacement with ordinary table writes, including the
    // empty-table case where no row exists to lock. This enforces --force at apply.
    if (replace || expectedPolicy)
      await tx.execute(sql`LOCK TABLE license_classifications IN SHARE ROW EXCLUSIVE MODE`);
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
    // Both overwrite and sync are scoped upserts. The plan supplies only selected keys.
    const rows = replace
      ? proposed
      : selectLicenseMaintenanceRows(artifact, [...existing.values()]);
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
    await beforeCommit?.();
  });
}

import { eq, notInArray, or, sql } from 'drizzle-orm';

import type { DbTransaction } from '@/lib/types';

import { db } from '@/db';
import {
  canonicalResources as bible_provider_resources,
  canonicalBibles as bibles,
} from '@/db/canonical-schema';
import { license_classifications } from '@/db/schema';
import { logger } from '@/lib/logger';

import type { LicenseArtifact, LicenseClassification } from '../license-artifact.schemas';
import type {
  LicenseDatabaseSnapshot,
  StoredLicenseClassification,
} from './license-database.types';

import { licenseArtifactSchema, licenseClassificationSchema } from '../license-artifact.schemas';
import { licenseDatabaseProjection } from './license-database-projection';

function rationaleText(content: (typeof license_classifications.$inferSelect)['rationale']) {
  return typeof content === 'string'
    ? content
    : content &&
        !Array.isArray(content) &&
        typeof content === 'object' &&
        typeof content.text === 'string'
      ? content.text
      : JSON.stringify(content) || 'No recorded rationale';
}

export async function getClassifications(tx: DbTransaction | typeof db = db) {
  return tx.select().from(license_classifications);
}

export async function loadClassificationSnapshot(): Promise<LicenseDatabaseSnapshot> {
  const [exists] = await db
    .select({ exists: sql<boolean>`to_regclass('license_classifications') IS NOT NULL` })
    .from(sql`(SELECT 1) AS existence_probe`);
  const [rows, resources] = await Promise.all([
    exists.exists ? getClassifications() : Promise.resolve([]),
    db
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
      .innerJoin(bibles, eq(bibles.textResourceId, bible_provider_resources.id)),
  ]);
  const classifications: StoredLicenseClassification[] = rows.map((row) => {
    const content = row.rationale;
    // Existing card rows may contain only a rationale; model/human evidence is optional.
    const text = rationaleText(content);
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
      evidence.data.normalizedText === row.normalizedText;
    if (metadata.evidence !== undefined && !usableEvidence)
      logger.warn({
        normalizedText: row.normalizedText,
        classifiedBy: row.classifiedBy,
        message:
          'Stored provenance does not match the current database decision; retaining exact table authority without stale evidence',
      });
    return {
      ...(usableEvidence
        ? {
            evidence: structuredClone(metadata.evidence) as LicenseClassification,
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
  force = false
) {
  const proposed = licenseDatabaseProjection(artifact);
  await db.transaction(async (tx) => {
    // Serialize initialization/replacement with ordinary table writes, including the
    // empty-table case where no row exists to lock. This enforces --force at apply.
    if (replace)
      await tx.execute(sql`LOCK TABLE license_classifications IN SHARE ROW EXCLUSIVE MODE`);
    const existing = new Map(
      (await getClassifications(tx)).map((row) => [row.normalizedText, row])
    );
    if (replace && existing.size && !force)
      throw new Error(
        'The classification table is now nonempty; --force is required before replacement'
      );
    const sources = new Map(
      artifact.classifications.map((row) => [row.normalizedText, row.source])
    );
    // A legacy table row may have no evidence to export. Maintenance must not invent
    // replacement provenance or churn its timestamps for an unchanged authoritative decision.
    const rows = proposed.filter((row) => {
      const old = existing.get(row.normalizedText);
      return (
        replace ||
        sources.get(row.normalizedText) !== 'table' ||
        !old ||
        old.status !== row.status ||
        rationaleText(old.rationale) !== row.rationale.text
      );
    });
    if (replace) {
      const keys = proposed.map((row) => row.normalizedText);
      await tx
        .delete(license_classifications)
        .where(keys.length ? notInArray(license_classifications.normalizedText, keys) : undefined);
    }
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
            reviewedAt: sql`excluded.reviewed_at`,
          },
          setWhere: or(
            sql`${license_classifications.status} IS DISTINCT FROM excluded.status`,
            sql`${license_classifications.rationale} IS DISTINCT FROM excluded.rationale`,
            sql`${license_classifications.classifiedBy} IS DISTINCT FROM excluded.classified_by`
          ),
        });
    }
    await beforeCommit?.();
  });
}

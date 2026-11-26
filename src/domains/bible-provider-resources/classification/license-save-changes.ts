import { isDeepStrictEqual } from 'node:util';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { StoredLicenseClassification } from './license-database.types';
import type { LicensePreview } from './license-workflow.types';

import { serializeLicenseArtifact } from '../license-artifact';
import { selectLicenseMaintenanceRows } from './license-database-projection';

function compareRecords<T>(
  group: string,
  prior: T[],
  planned: T[],
  key: (record: T) => string,
  preserved: Set<string> = new Set(),
  ordered = false
) {
  const before = new Map(prior.map((record, index) => [key(record), { record, index }]));
  const after = new Map(planned.map((record, index) => [key(record), { record, index }]));
  return [...new Set([...after.keys(), ...before.keys()])].map((id) => {
    const left = before.get(id);
    const right = after.get(id);
    const operation = !left
      ? 'Insert'
      : !right
        ? 'Delete'
        : !isDeepStrictEqual(left.record, right.record)
          ? 'Update'
          : ordered && left.index !== right.index
            ? 'Move'
            : preserved.has(id)
              ? 'Preserve'
              : 'Unchanged';
    return {
      group,
      key: id,
      operation,
      ...(preserved.has(id) && { decision: 'Keep destination decision' }),
      ...(ordered && { beforeIndex: left?.index ?? null, afterIndex: right?.index ?? null }),
      before: left?.record ?? null,
      after: right?.record ?? null,
    };
  });
}

function jsonRecords(prior: LicenseArtifact | null, planned: LicenseArtifact, preserved: string[]) {
  const { classifications, catalog, ...metadata } = planned;
  const { classifications: oldRows, catalog: oldCatalog, ...oldMetadata } = prior ?? {};
  return [
    ...compareRecords('File metadata', prior ? [oldMetadata] : [], [metadata], () => 'Artifact'),
    ...compareRecords(
      'Classification',
      oldRows ?? [],
      classifications,
      (row) => row.normalizedText,
      new Set(preserved),
      true
    ),
    ...compareRecords(
      'Catalog',
      oldCatalog ?? [],
      catalog,
      (row) => JSON.stringify([row.provider, row.externalId]),
      undefined,
      true
    ),
  ];
}

function databaseRecords(
  artifact: LicenseArtifact,
  existing: StoredLicenseClassification[],
  preserved: string[]
) {
  const prior = existing.map((row) => ({
    normalizedText: row.normalizedText,
    rationale: row.storedRationale === undefined ? row.rationale : row.storedRationale,
    status: row.status,
    classifiedBy: row.classifiedBy,
    reviewedAt: row.reviewedAt,
    reviewState: row.reviewState ?? 'unreviewed',
    reviewedBy: row.reviewedBy ?? null,
    humanReviewedAt: row.humanReviewedAt ?? null,
    decisionAt: row.decisionAt ?? null,
  }));
  const after = new Map(prior.map((row) => [row.normalizedText, row]));
  for (const row of selectLicenseMaintenanceRows(artifact, existing)) {
    after.set(row.normalizedText, {
      ...row,
      reviewedAt: after.get(row.normalizedText)?.reviewedAt ?? null,
      decisionAt: row.decisionAt?.toISOString() ?? null,
      humanReviewedAt: row.humanReviewedAt?.toISOString() ?? null,
    });
  }
  return compareRecords(
    'Policy',
    prior,
    [...after.values()],
    (row) => row.normalizedText,
    new Set(preserved)
  );
}

/** Build on demand from the frozen inputs and the bytes/projection used by the writers. */
export function licenseSaveChanges(
  preview: Pick<LicensePreview, 'plan' | 'reviewer' | 'reviewedAt' | 'token'>,
  databaseLabel: string
) {
  const { plan } = preview;
  const target = plan.targets[0];
  const destinations = [];
  if (plan.jsonArtifact && target) {
    const { bytes, wholeFileHash } = serializeLicenseArtifact(plan.jsonArtifact);
    destinations.push({
      kind: 'JSON',
      target: target.path,
      wholeFileHash,
      records: jsonRecords(
        target.previous === null ? null : JSON.parse(target.previous),
        JSON.parse(bytes),
        plan.jsonChanges.preserved
      ),
    });
  }
  if (plan.databaseArtifact)
    destinations.push({
      kind: 'Database',
      target: databaseLabel,
      records: databaseRecords(
        plan.databaseArtifact,
        plan.databaseBefore ?? [],
        plan.databaseChanges.preserved
      ),
    });
  return {
    previewToken: preview.token,
    reviewer: preview.reviewer,
    reviewedAt: preview.reviewedAt,
    destinations,
  };
}

import { createHash } from 'node:crypto';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseDatabaseContext } from '../license-impact';

import { computeLicenseImpact } from '../license-impact';
import { normalizeLicenseNotice } from '../license-normalizer';

export interface LicenseReviewQuery {
  search: string;
  status: 'all' | 'allowed' | 'forbidden' | 'unknown';
  source: 'all' | 'table' | 'rule' | 'gemini' | 'manual';
  page: number;
}

const pageSize = 25;
const rowId = (normalizedText: string) => createHash('sha256').update(normalizedText).digest('hex');

function savedVariants(artifact: LicenseArtifact, normalizedText: string) {
  return [
    ...new Set([
      artifact.classifications.find((row) => row.normalizedText === normalizedText)!.exampleNotice,
      ...artifact.catalog
        .filter(
          (bible) =>
            bible.rawNotice !== null &&
            bible.rawNotice.trim() !== '' &&
            normalizeLicenseNotice(bible.rawNotice) === normalizedText
        )
        .map((bible) => bible.rawNotice!),
    ]),
  ];
}

export function listLicenseWorkbenchReview(
  artifact: LicenseArtifact,
  query: LicenseReviewQuery,
  database?: LicenseDatabaseContext,
  preserveExistingNonUnknowns = false
) {
  const search = query.search.toLocaleLowerCase();
  const impact = computeLicenseImpact(artifact, database, preserveExistingNonUnknowns);
  const rows = artifact.classifications
    .map((row) => {
      const affected = impact.rows.filter((bible) => bible.normalizedText === row.normalizedText);
      const variants = savedVariants(artifact, row.normalizedText);
      const votes = { allowed: 0, forbidden: 0, unknown: 0 };
      for (const sample of row.samples) votes[sample.result.decision]++;
      return {
        id: rowId(row.normalizedText),
        normalizedText: row.normalizedText,
        preview: row.exampleNotice.slice(0, 240),
        status: row.status,
        source: row.source,
        votes,
        sampleCount: row.samples.length,
        bibleCount: affected.length,
        bibleNames: affected.map((bible) => bible.name),
        searchText: [
          row.normalizedText,
          row.exampleNotice,
          row.rationale,
          row.rowNote ?? '',
          ...variants,
          ...affected.flatMap((bible) => [
            bible.name,
            bible.abbreviation,
            bible.provider,
            bible.externalId,
            bible.rawNotice ?? '',
            bible.bibleId?.toString() ?? '',
          ]),
        ]
          .join(' ')
          .toLocaleLowerCase(),
      };
    })
    .filter(
      (row) =>
        (query.status === 'all' || row.status === query.status) &&
        (query.source === 'all' || row.source === query.source) &&
        row.searchText.includes(search)
    )
    .sort((a, b) =>
      a.normalizedText < b.normalizedText ? -1 : a.normalizedText > b.normalizedText ? 1 : 0
    );
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(query.page, pageCount);
  return {
    page,
    pageSize,
    pageCount,
    total,
    allCount: artifact.classifications.length,
    context: impact.context,
    rows: rows.slice((page - 1) * pageSize, page * pageSize).map(({ searchText, ...row }) => row),
  };
}

export function getLicenseWorkbenchReviewDetail(
  artifact: LicenseArtifact,
  id: string,
  database?: LicenseDatabaseContext,
  preserveExistingNonUnknowns = false
) {
  const row = artifact.classifications.find((entry) => rowId(entry.normalizedText) === id);
  if (!row) return null;
  const impact = computeLicenseImpact(artifact, database, preserveExistingNonUnknowns);
  const affected = impact.rows.filter((bible) => bible.normalizedText === row.normalizedText);
  const variants = savedVariants(artifact, row.normalizedText);
  return {
    id,
    ...row,
    context: impact.context,
    variants,
    bibles: affected.map((bible) => ({
      provider: bible.provider,
      externalId: bible.externalId,
      bibleId: bible.bibleId,
      name: bible.name,
      abbreviation: bible.abbreviation,
      rawNotice: bible.rawNotice,
      currentNotice: bible.currentNotice,
      snapshotNotice: bible.snapshotNotice,
    })),
    modelEvidenceLabel: row.samples.length
      ? 'Historical saved model evidence; these are not current requests.'
      : 'No model request was recorded for this classification.',
  };
}

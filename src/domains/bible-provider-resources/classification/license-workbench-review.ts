import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseDatabaseContext } from '../license-impact';
import type { LicenseReviewDrafts } from './license-review-drafts';

import { licenseOverrideWarning } from '../license-artifact';
import { computeLicenseImpact } from '../license-impact';
import { displayLicenseNotice, normalizeLicenseNotice } from '../license-normalizer';

export const reviewQuerySchema = z.object({
  search: z.string().max(500).default(''),
  status: z.enum(['all', 'allowed', 'forbidden', 'unknown']).default('all'),
  source: z.enum(['all', 'table', 'rule', 'gemini', 'manual']).default('all'),
  reviewState: z.enum(['all', 'unreviewed', 'llm_reviewed', 'human_reviewed']).default('all'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
});

export type LicenseReviewQuery = Pick<
  z.output<typeof reviewQuerySchema>,
  'search' | 'status' | 'source' | 'page'
> &
  Partial<Pick<z.output<typeof reviewQuerySchema>, 'reviewState' | 'pageSize'>>;

export const licenseReviewRowId = (normalizedText: string) =>
  createHash('sha256').update(normalizedText).digest('hex');

function catalogVariants(artifact: LicenseArtifact) {
  const variants = new Map<string, Set<string>>();
  for (const { rawNotice } of artifact.catalog) {
    if (!rawNotice?.trim()) continue;
    const key = normalizeLicenseNotice(rawNotice);
    const notices = variants.get(key) ?? new Set<string>();
    notices.add(rawNotice);
    variants.set(key, notices);
  }
  return variants;
}

function savedVariants(example: string | null, catalog?: Set<string>) {
  return [...new Set([...(example === null ? [] : [example]), ...(catalog ?? [])])];
}

export function listLicenseWorkbenchReview(
  artifact: LicenseArtifact,
  query: LicenseReviewQuery,
  database?: LicenseDatabaseContext,
  preserveExistingNonUnknowns = false,
  drafts?: Pick<LicenseReviewDrafts, 'values'>,
  anchor?: string
) {
  const pageSize = query.pageSize ?? 25;
  const search = query.search.toLocaleLowerCase();
  const impact = computeLicenseImpact(artifact, database, preserveExistingNonUnknowns);
  const byNotice = Map.groupBy(impact.rows, (bible) => bible.normalizedText);
  const catalog = catalogVariants(artifact);
  const rows = artifact.classifications
    .map((row) => {
      const affected = byNotice.get(row.normalizedText) ?? [];
      const variants = savedVariants(row.exampleNotice, catalog.get(row.normalizedText));
      const votes = { allowed: 0, forbidden: 0, unknown: 0 };
      for (const sample of row.samples) votes[sample.result.decision]++;
      const values = drafts?.values(row);
      return {
        id: licenseReviewRowId(row.normalizedText),
        normalizedText: row.normalizedText,
        preview: displayLicenseNotice(row.exampleNotice).slice(0, 240),
        status: row.status,
        reviewState: row.reviewState,
        reviewedBy: row.reviewedBy,
        decisionAt: row.decisionAt,
        ...values,
        source: values?.pending ? ('manual' as const) : row.source,
        votes,
        sampleCount: row.samples.length,
        bibleCount: affected.length,
        bibleNames: affected.map((bible) => bible.name),
        searchText: [
          row.normalizedText,
          row.exampleNotice,
          row.rationale,
          row.rowNote ?? '',
          (values ? values.reviewComment : row.reviewComment) ?? '',
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
        (!query.reviewState ||
          query.reviewState === 'all' ||
          row.reviewState === query.reviewState) &&
        row.searchText.includes(search)
    )
    .sort((a, b) =>
      a.normalizedText < b.normalizedText ? -1 : a.normalizedText > b.normalizedText ? 1 : 0
    );
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(query.page, pageCount);
  const eligible = rows.filter((row) => row.reviewState !== 'human_reviewed');
  const navigation =
    anchor === undefined
      ? undefined
      : {
          previousId: rows.findLast((row) => row.normalizedText < anchor)?.id ?? null,
          nextId: rows.find((row) => row.normalizedText > anchor)?.id ?? null,
          nextEligibleId:
            (eligible.find((row) => row.normalizedText > anchor) ?? eligible[0])?.id ?? null,
        };
  return {
    remaining: eligible.length,
    rangeStart: total ? (page - 1) * pageSize + 1 : 0,
    rangeEnd: Math.min(page * pageSize, total),
    navigation,
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
  preserveExistingNonUnknowns = false,
  drafts?: Pick<LicenseReviewDrafts, 'values'>
) {
  const row = artifact.classifications.find(
    (entry) => licenseReviewRowId(entry.normalizedText) === id
  );
  if (!row) return null;
  const impact = computeLicenseImpact(artifact, database, preserveExistingNonUnknowns);
  const affected = impact.rows.filter((bible) => bible.normalizedText === row.normalizedText);
  const variants = savedVariants(
    row.exampleNotice,
    catalogVariants(artifact).get(row.normalizedText)
  );
  return {
    normalizedText: row.normalizedText,
    exampleNotice: row.exampleNotice,
    status: row.status,
    reviewState: row.reviewState,
    decisionAt: row.decisionAt,
    reviewedBy: row.reviewedBy,
    humanReviewedAt: row.humanReviewedAt,
    source: drafts?.values(row).pending ? 'manual' : row.source,
    rationale: row.rationale,
    rule: row.rule,
    samples: row.samples,
    evidenceContract: row.evidenceContract,
    automaticDecision: row.automaticDecision,
    rowNote: row.rowNote,
    context: impact.context,
    variants,
    variantLabels: variants.map(displayLicenseNotice),
    missingNoticeLabel: variants.length ? null : displayLicenseNotice(row.exampleNotice),
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
    overrideWarnings: {
      allowed: licenseOverrideWarning(row, 'allowed'),
      forbidden: licenseOverrideWarning(row, 'forbidden'),
      unknown: licenseOverrideWarning(row, 'unknown'),
    },
    ...drafts?.values(row),
    id,
  };
}

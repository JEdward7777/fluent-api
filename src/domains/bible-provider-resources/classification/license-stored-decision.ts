import type { license_classifications } from '@/db/schema';

import type { LicenseArtifact, LicenseClassification } from '../license-artifact.schemas';
import type { StoredLicenseClassification } from './license-database.types';

import {
  licenseArtifactSchema,
  licenseClassificationSchema,
  parseStoredLicenseEvidence,
} from '../license-artifact.schemas';
import { validateLicenseEvidence } from '../license-artifact.validation';
import { normalizeLicenseNotice } from '../license-normalizer';
import { restoreStoredExtensions } from './license-database-extensions';

export function databaseRationaleText(row: Pick<LicenseClassification, 'source' | 'rationale'>) {
  return row.source === 'manual' && row.rationale === ''
    ? 'Human-reviewed decision'
    : row.rationale;
}

function licenseRationaleText(content: unknown) {
  return typeof content === 'string'
    ? content
    : content &&
        !Array.isArray(content) &&
        typeof content === 'object' &&
        'text' in content &&
        typeof content.text === 'string'
      ? content.text
      : JSON.stringify(content) || 'No recorded rationale';
}

export function licenseDecisionProducer(
  row: LicenseClassification,
  contract?: LicenseArtifact['classificationRun']
) {
  switch (row.source) {
    case 'manual':
      return 'human';
    case 'rule':
      return `rule:${row.rule?.id}`;
    case 'gemini':
      return (
        contract?.models
          .map((model) => `${model.provider}:${model.model}`)
          .sort()
          .join(',') ?? null
      );
    case 'table':
      return 'table';
  }
}

function originalV2(content: StoredLicenseClassification['storedRationale']) {
  return (
    content &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    content.evidenceVersion === undefined &&
    content.evidence &&
    typeof content.evidence === 'object' &&
    !Object.hasOwn(content.evidence, 'reviewState')
  );
}

function matchesColumnTime(column: string | null | undefined, evidence: string | null | undefined) {
  return (
    column === undefined ||
    column === evidence ||
    (column != null && evidence != null && Date.parse(column) === Date.parse(evidence))
  );
}

function currentEvidence(row: StoredLicenseClassification) {
  const evidence = row.evidence;
  if (!evidence) return;
  const contract = evidence.evidenceContract ?? row.classificationRun;
  if (
    row.normalizedText !== evidence.normalizedText ||
    row.status !== evidence.status ||
    databaseRationaleText(evidence) !== row.rationale ||
    row.classifiedBy !== licenseDecisionProducer(evidence, contract) ||
    (row.reviewState !== undefined &&
      row.reviewState !== evidence.reviewState &&
      !(
        originalV2(row.storedRationale) &&
        row.reviewState === 'unreviewed' &&
        evidence.reviewState === 'llm_reviewed' &&
        evidence.decisionAt === null &&
        evidence.reviewedBy === null &&
        evidence.humanReviewedAt === null
      )) ||
    !matchesColumnTime(row.decisionAt, evidence.decisionAt) ||
    !matchesColumnTime(row.humanReviewedAt, evidence.humanReviewedAt) ||
    (row.reviewedBy !== undefined && row.reviewedBy !== evidence.reviewedBy)
  )
    return;
  try {
    validateLicenseEvidence(evidence, contract);
  } catch {
    return;
  }
  return evidence;
}

export function readStoredLicenseClassification(
  row: typeof license_classifications.$inferSelect,
  logging?: Pick<typeof import('@/lib/logger').logger, 'warn'>
): StoredLicenseClassification {
  const content = row.rationale;
  const metadata = content && typeof content === 'object' && !Array.isArray(content) ? content : {};
  const evidence = parseStoredLicenseEvidence(metadata.evidence, metadata.evidenceVersion);
  const run = licenseArtifactSchema.shape.classificationRun.safeParse(metadata.classificationRun);
  const stored: StoredLicenseClassification = {
    normalizedText: row.normalizedText,
    status: row.status,
    rationale: licenseRationaleText(content) || 'No recorded rationale',
    storedRationale: content,
    classifiedBy: row.classifiedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewState: row.reviewState,
    decisionAt: row.decisionAt?.toISOString() ?? null,
    reviewedBy: row.reviewedBy,
    humanReviewedAt: row.humanReviewedAt?.toISOString() ?? null,
  };
  if (evidence && (run.success || (!evidence.samples.length && !evidence.rule))) {
    stored.evidence = evidence;
    if (run.success)
      stored.classificationRun = structuredClone(
        metadata.classificationRun
      ) as LicenseArtifact['classificationRun'];
    if (currentEvidence(stored)) {
      if (metadata.evidenceVersion === 4)
        restoreStoredExtensions(evidence, stored.classificationRun, metadata);
      return stored;
    }
    delete stored.evidence;
    delete stored.classificationRun;
  }
  if (metadata.evidence !== undefined)
    logging?.warn({
      normalizedText: row.normalizedText,
      classifiedBy: row.classifiedBy,
      message:
        'Stored provenance does not match the current database decision; retaining exact table authority without stale evidence',
    });
  return stored;
}

export function storedLicenseDecision(
  row: StoredLicenseClassification,
  rawExample?: string | null
): LicenseClassification {
  const example = row.exampleNotice ?? rawExample ?? null;
  if (example !== null && normalizeLicenseNotice(example) !== row.normalizedText)
    throw new Error('Classification key does not match exact notice normalization');
  const evidence =
    row.evidence &&
    licenseClassificationSchema.safeParse(row.evidence).success &&
    currentEvidence(row);
  if (evidence) {
    const decision = structuredClone(evidence);
    if ((decision.samples.length || decision.rule) && !decision.evidenceContract)
      decision.evidenceContract = row.classificationRun;
    return decision;
  }
  if (row.reviewState === 'llm_reviewed')
    throw new Error(`Stored LLM review for ${row.normalizedText} requires complete model evidence`);
  const fallback: LicenseClassification = {
    normalizedText: row.normalizedText,
    exampleNotice: example,
    status: row.status,
    source: 'table',
    rationale: row.rationale,
    samples: [],
    reviewState: row.reviewState ?? 'unreviewed',
    decisionAt: row.decisionAt ?? null,
    reviewedBy: row.reviewedBy ?? null,
    humanReviewedAt: row.humanReviewedAt ?? null,
  };
  licenseClassificationSchema.parse(fallback);
  validateLicenseEvidence(fallback);
  return fallback;
}

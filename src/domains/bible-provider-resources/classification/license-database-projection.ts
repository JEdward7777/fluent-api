import { hashCanonicalJson } from '@/lib/llm/canonical-json';

import type { LicenseArtifact, LicenseClassification } from '../license-artifact.schemas';
import type { StoredLicenseClassification } from './license-database.types';

import { projectStoredExtensions } from './license-database-extensions';
import {
  databaseRationaleText,
  licenseDecisionProducer,
  storedLicenseDecision,
} from './license-stored-decision';

function ownedContract(run: LicenseArtifact['classificationRun']) {
  return {
    prompt: run.prompt,
    promptHash: run.promptHash,
    ruleSetHash: run.ruleSetHash,
    responseSchema: run.responseSchema,
    models: run.models
      .map((model) => ({
        provider: model.provider,
        model: model.model,
        sampleCount: model.sampleCount,
        settings: model.settings,
      }))
      .sort((a, b) =>
        a.provider < b.provider
          ? -1
          : a.provider > b.provider
            ? 1
            : a.model < b.model
              ? -1
              : a.model > b.model
                ? 1
                : 0
      ),
  };
}

/** An explicit projection: passthrough extensions can never become database authority. */
function ownedLicenseClassification(
  row: LicenseClassification,
  contract: LicenseArtifact['classificationRun']
) {
  return structuredClone({
    normalizedText: row.normalizedText,
    exampleNotice: row.exampleNotice,
    status: row.status,
    source: row.source,
    rationale: row.rationale,
    samples: row.samples
      .map((sample) => ({
        index: sample.index,
        provider: sample.provider,
        model: sample.model,
        requestHash: sample.requestHash,
        request: sample.request,
        response: sample.response,
        result: { rationale: sample.result.rationale, decision: sample.result.decision },
      }))
      .sort((a, b) =>
        a.provider < b.provider
          ? -1
          : a.provider > b.provider
            ? 1
            : a.model < b.model
              ? -1
              : a.model > b.model
                ? 1
                : a.index - b.index
      ),
    ...(row.evidenceContract || row.samples.length || row.rule
      ? { evidenceContract: ownedContract(row.evidenceContract ?? contract) }
      : {}),
    ...(row.rule ? { rule: row.rule } : {}),
    ...(row.automaticDecision ? { automaticDecision: row.automaticDecision } : {}),
    ...(row.reviewComment !== undefined ? { reviewComment: row.reviewComment } : {}),
    ...(row.reviewHistory?.length ? { reviewHistory: row.reviewHistory } : {}),
    ...(row.rowNoteProvenance ? { rowNoteProvenance: row.rowNoteProvenance } : {}),
    ...(row.rowNote ? { rowNote: row.rowNote } : {}),
    reviewState: row.reviewState ?? 'unreviewed',
    decisionAt: row.decisionAt ?? null,
    reviewedBy: row.reviewedBy ?? null,
    humanReviewedAt: row.humanReviewedAt ?? null,
  });
}

export function licenseDatabaseProjection(artifact: LicenseArtifact) {
  return artifact.classifications.map((row) => {
    const run = row.evidenceContract ?? artifact.classificationRun;
    const classificationRun = ownedContract(run);
    const extensions = projectStoredExtensions(row, run);
    return {
      normalizedText: row.normalizedText,
      status: row.status,
      rationale: {
        evidenceVersion: 4,
        // Keep passthrough JSON outside the evidence that selects and compares decisions.
        ...extensions,
        text: databaseRationaleText(row),
        evidence: ownedLicenseClassification(row, run),
        ...(row.samples.length || row.rule ? { classificationRun } : {}),
      },
      classifiedBy: licenseDecisionProducer(row, run),
      reviewedAt: null,
      reviewState: row.reviewState ?? 'unreviewed',
      decisionAt: row.decisionAt ? new Date(row.decisionAt) : null,
      reviewedBy: row.reviewedBy ?? null,
      humanReviewedAt: row.humanReviewedAt ? new Date(row.humanReviewedAt) : null,
    };
  });
}

function comparisonHash(row: ReturnType<typeof ownedLicenseClassification>) {
  return hashCanonicalJson({
    ...row,
    decisionAt: row.decisionAt === null ? null : Date.parse(row.decisionAt),
    humanReviewedAt: row.humanReviewedAt === null ? null : Date.parse(row.humanReviewedAt),
  });
}

/**
 * Compare complete owned decisions so changing the storage representation alone
 * cannot rewrite untouched legacy evidence, producer labels or timestamps.
 */
export function selectLicenseMaintenanceRows(
  artifact: LicenseArtifact,
  existing: StoredLicenseClassification[]
) {
  const before = new Map(existing.map((row) => [row.normalizedText, row]));
  return licenseDatabaseProjection(artifact).filter((projected) => {
    const old = before.get(projected.normalizedText);
    if (!old) return true;
    const stored = storedLicenseDecision(old, projected.rationale.evidence.exampleNotice);
    const prior = ownedLicenseClassification(
      stored,
      old.classificationRun ?? artifact.classificationRun
    );
    // Column-only policies never stored a spelling for the raw notice.
    if (!old.evidence && projected.rationale.evidence.source === 'table')
      prior.exampleNotice = projected.rationale.evidence.exampleNotice;
    return comparisonHash(prior) !== comparisonHash(projected.rationale.evidence);
  });
}

export function planLicenseDatabaseChanges(
  artifact: LicenseArtifact,
  existing: StoredLicenseClassification[]
) {
  const before = new Set(existing.map((row) => row.normalizedText));
  const rows = selectLicenseMaintenanceRows(artifact, existing);
  return {
    deletedKeys: [] as string[],
    insertedKeys: rows
      .filter((row) => !before.has(row.normalizedText))
      .map((row) => row.normalizedText),
    changedKeys: rows
      .filter((row) => before.has(row.normalizedText))
      .map((row) => row.normalizedText),
  };
}

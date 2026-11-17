import type { JsonValue } from '@/lib/llm/canonical-json';

import { hashCanonicalJson } from '@/lib/llm/canonical-json';

import type { LicenseArtifact, LicenseClassification } from '../license-artifact.schemas';
import type { StoredLicenseClassification } from './license-database.types';

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
    ...(row.samples.length || row.rule
      ? { evidenceContract: ownedContract(row.evidenceContract ?? contract) }
      : {}),
    ...(row.rule ? { rule: row.rule } : {}),
    ...(row.automaticDecision ? { automaticDecision: row.automaticDecision } : {}),
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
    return {
      normalizedText: row.normalizedText,
      status: row.status,
      rationale: {
        text: row.rationale,
        evidence: ownedLicenseClassification(row, run),
        ...(row.samples.length || row.rule ? { classificationRun } : {}),
      },
      classifiedBy:
        row.source === 'manual'
          ? 'human'
          : row.source === 'rule'
            ? `rule:${row.rule!.id}`
            : row.source === 'gemini'
              ? run.models
                  .map((model) => `${model.provider}:${model.model}`)
                  .sort()
                  .join(',')
              : 'table',
      reviewedAt: null,
      reviewState: row.reviewState ?? 'unreviewed',
      decisionAt: row.decisionAt ? new Date(row.decisionAt) : null,
      reviewedBy: row.reviewedBy ?? null,
      humanReviewedAt: row.humanReviewedAt ? new Date(row.humanReviewedAt) : null,
    };
  });
}

export function licenseRationaleText(content: unknown) {
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

/** Keep maintenance's legacy-table preservation predicate identical to the transaction writer. */
export function selectLicenseMaintenanceRows(
  artifact: LicenseArtifact,
  existing: {
    normalizedText: string;
    status: LicenseClassification['status'];
    rationale: unknown;
    storedRationale?: unknown;
    reviewState?: LicenseClassification['reviewState'];
    decisionAt?: string | Date | null;
    reviewedBy?: string | null;
    humanReviewedAt?: string | Date | null;
    classifiedBy?: string | null;
  }[]
) {
  const before = new Map(existing.map((row) => [row.normalizedText, row]));
  const sources = new Map(artifact.classifications.map((row) => [row.normalizedText, row.source]));
  return licenseDatabaseProjection(artifact).filter((row) => {
    const old = before.get(row.normalizedText);
    if (!old) return true;
    // A legacy table row with no evidence is already authoritative. Preserve its
    // producer and timestamps unless the decision or owned metadata actually changed.
    const priorDecisionAt =
      old.decisionAt instanceof Date ? old.decisionAt.toISOString() : (old.decisionAt ?? null);
    const priorHumanAt =
      old.humanReviewedAt instanceof Date
        ? old.humanReviewedAt.toISOString()
        : (old.humanReviewedAt ?? null);
    const unchangedLegacy =
      sources.get(row.normalizedText) === 'table' &&
      old.status === row.status &&
      licenseRationaleText(old.storedRationale ?? old.rationale) === row.rationale.text &&
      (old.reviewState ?? 'unreviewed') === row.reviewState &&
      priorDecisionAt === (row.decisionAt?.toISOString() ?? null) &&
      (old.reviewedBy ?? null) === row.reviewedBy &&
      priorHumanAt === (row.humanReviewedAt?.toISOString() ?? null);
    return (
      !unchangedLegacy &&
      (old.status !== row.status ||
        old.classifiedBy !== row.classifiedBy ||
        (old.reviewState ?? 'unreviewed') !== row.reviewState ||
        priorDecisionAt !== (row.decisionAt?.toISOString() ?? null) ||
        (old.reviewedBy ?? null) !== row.reviewedBy ||
        priorHumanAt !== (row.humanReviewedAt?.toISOString() ?? null) ||
        hashCanonicalJson((old.storedRationale ?? old.rationale) as JsonValue) !==
          hashCanonicalJson(row.rationale))
    );
  });
}

/** Immediate maintenance diff; resource status forecasts are reported separately. */
export function planLicenseMaintenanceChanges(
  artifact: LicenseArtifact,
  existing: StoredLicenseClassification[]
) {
  const before = new Map(existing.map((row) => [row.normalizedText, row]));
  const rows = selectLicenseMaintenanceRows(artifact, existing);
  return {
    insertedKeys: rows
      .filter((row) => !before.has(row.normalizedText))
      .map((row) => row.normalizedText),
    changedKeys: rows
      .filter((row) => {
        const old = before.get(row.normalizedText);
        return (
          old &&
          (old.reviewState !== row.reviewState ||
            old.decisionAt !== (row.decisionAt?.toISOString() ?? null) ||
            old.reviewedBy !== row.reviewedBy ||
            old.humanReviewedAt !== (row.humanReviewedAt?.toISOString() ?? null) ||
            old.status !== row.status ||
            old.classifiedBy !== row.classifiedBy ||
            hashCanonicalJson(old.storedRationale ?? old.rationale) !==
              hashCanonicalJson(row.rationale))
        );
      })
      .map((row) => row.normalizedText),
    deletedKeys: [] as string[],
  };
}

/** Mirrors the apply query's status/rationale/producer distinct-value predicate. */
export function planLicenseDatabaseChanges(
  artifact: LicenseArtifact,
  existing: StoredLicenseClassification[]
) {
  const before = new Map(existing.map((row) => [row.normalizedText, row]));
  const proposed = licenseDatabaseProjection(artifact);
  return {
    deletedKeys: [] as string[],
    insertedKeys: proposed
      .filter((row) => !before.has(row.normalizedText))
      .map((row) => row.normalizedText),
    changedKeys: proposed
      .filter((row) => {
        const old = before.get(row.normalizedText);
        return (
          old &&
          (old.reviewState !== row.reviewState ||
            old.decisionAt !== (row.decisionAt?.toISOString() ?? null) ||
            old.reviewedBy !== row.reviewedBy ||
            old.humanReviewedAt !== (row.humanReviewedAt?.toISOString() ?? null) ||
            old.status !== row.status ||
            old.classifiedBy !== row.classifiedBy ||
            hashCanonicalJson(old.storedRationale ?? old.rationale) !==
              hashCanonicalJson(row.rationale))
        );
      })
      .map((row) => row.normalizedText),
  };
}

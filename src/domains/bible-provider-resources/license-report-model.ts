import type { LicenseDatabaseContext } from './license-impact';

import { serializeLicenseArtifact } from './license-artifact';
import { computeLicenseImpact } from './license-impact';
import { freezeLicenseRevision, freezeReviewValue } from './license-review-revision';

export function buildLicenseReportModel(
  value: unknown,
  database?: LicenseDatabaseContext,
  preserveExistingNonUnknowns = false
) {
  const artifact = freezeLicenseRevision(value);
  const impact = computeLicenseImpact(artifact, database, preserveExistingNonUnknowns);
  const serialized = serializeLicenseArtifact(artifact);
  const inventory = [...artifact.classifications]
    .sort((left, right) =>
      left.normalizedText < right.normalizedText
        ? -1
        : left.normalizedText > right.normalizedText
          ? 1
          : 0
    )
    .map((row) => ({
      normalizedText: row.normalizedText,
      exampleNotice: row.exampleNotice,
      status: row.status,
      rationale: row.rationale,
      source: row.source,
      rowNote: row.rowNote ?? null,
      automaticDecision: row.automaticDecision ?? null,
      rule: row.rule ?? null,
      samples: row.samples.map((sample) => ({
        index: sample.index,
        provider: sample.provider,
        model: sample.model,
        decision: sample.result.decision,
        rationale: sample.result.rationale,
        response: sample.response,
        requestHash: sample.requestHash,
        request: sample.request,
      })),
      bibles: impact.rows
        .filter((bible) => bible.normalizedText === row.normalizedText)
        .map((bible) => ({
          provider: bible.provider,
          externalId: bible.externalId,
          bibleId: bible.bibleId,
          name: bible.name,
          abbreviation: bible.abbreviation,
          rawNotice: bible.rawNotice,
        })),
    }));
  return freezeReviewValue({
    artifact,
    reviewContentHash: artifact.reviewContentHash,
    wholeFileHash: serialized.wholeFileHash,
    artifactBytes: serialized.bytes,
    reviewState: artifact.reviewState ?? 'attested',
    attestation: artifact.attestation ?? null,
    models: artifact.classificationRun.models.map((model) => ({
      provider: model.provider,
      model: model.model,
      sampleCount: model.sampleCount,
    })),
    impact,
    inventory,
  });
}
export type LicenseReportModel = ReturnType<typeof buildLicenseReportModel>;

/** Always available, including when no report files are selected. Counts describe this frozen revision. */
export function licenseInlineSummary(model: LicenseReportModel): string {
  const { impact } = model;
  const database = impact.context.kind === 'database';
  return [
    impact.context.disclaimer,
    `Classification decisions: allowed ${impact.classificationTotals.allowed}, forbidden ${impact.classificationTotals.forbidden}, unknown ${impact.classificationTotals.unknown}.`,
    `${database ? 'Projected status after ordinary derived sync' : 'Artifact catalog decisions'}: allowed ${impact.totals.allowed}, forbidden ${impact.totals.forbidden}, unknown ${impact.totals.unknown}.`,
    `Projected status changes: ${database ? impact.changes.length : 'unavailable'}; new catalog records: ${database ? impact.newCatalogRows.length : 'unavailable'}; notice changes: ${database ? impact.noticeChanges.length : 'unavailable'}; unchanged status/notice: ${impact.unchanged ?? 'unavailable'}.`,
    `TTS eligibility gains: ${impact.ttsGains ?? 'unavailable'}; losses: ${impact.ttsLosses ?? 'unavailable'}; normalization collisions: ${impact.collisions.length}; missing exact classifications: ${impact.missingClassifications.length}.`,
    `Recorded evidence diagnostics: ${impact.diagnostics.cacheHits} cache hits; ${impact.diagnostics.newCalls} provider calls.`,
    ...(impact.preservationWarning
      ? [impact.preservationWarning, `Preservation disagreements: ${impact.disagreements.length}.`]
      : []),
    `Revision ${model.reviewContentHash}; JSON review ${model.reviewState}.`,
  ].join('\n');
}

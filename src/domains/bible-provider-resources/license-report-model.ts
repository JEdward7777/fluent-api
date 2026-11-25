import type { LicenseArtifact } from './license-artifact.schemas';
import type { LicenseDatabaseContext } from './license-impact';

import { serializeLicenseArtifact } from './license-artifact';
import { computeLicenseImpact } from './license-impact';
import { displayLicenseNotice } from './license-normalizer';
import { freezeLicenseRevision, freezeReviewValue } from './license-review-revision';

export interface LicenseReportTargets {
  json?: {
    path: string;
    reviewContentHash: string;
    wholeFileHash: string;
    assertion?: LicenseArtifact['attestation'];
  };
  database?: { reviewContentHash: string; label?: string };
}

export function buildLicenseReportModel(
  value: unknown,
  database?: LicenseDatabaseContext,
  preserveExistingNonUnknowns = false,
  impactArtifact?: LicenseArtifact,
  targets?: LicenseReportTargets
) {
  const artifact = freezeLicenseRevision(value);
  const impact = computeLicenseImpact(
    artifact,
    database,
    preserveExistingNonUnknowns,
    impactArtifact
  );
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
      exampleNotice: displayLicenseNotice(row.exampleNotice),
      status: row.status,
      rationale: row.rationale,
      source: row.source,
      rowNote: row.rowNote ?? null,
      reviewComment: row.reviewComment ?? null,
      reviewedBy: row.reviewedBy ?? null,
      humanReviewedAt: row.humanReviewedAt ?? null,
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
    targets,
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

export function licenseReportRevisionLines(
  model: LicenseReportModel,
  escape = (value: string) => value
) {
  const { json, database } = model.targets ?? {};
  const assertionLine = (scope: string, assertion: LicenseArtifact['attestation'] | null) =>
    assertion
      ? `${scope} whole-file assertion by ${escape(assertion.reviewedBy)} at ${assertion.reviewedAt}: ${escape(assertion.reviewReason)}`
      : `${scope} whole-file assertion: absent.`;
  return [
    `Working review SHA-256: ${model.reviewContentHash}`,
    `Working JSON whole-file SHA-256: ${model.wholeFileHash}`,
    `Working JSON review state: ${model.reviewState}`,
    assertionLine('Working', model.attestation),
    ...(json
      ? [
          `Planned JSON target: ${escape(json.path)}`,
          `JSON target review SHA-256: ${json.reviewContentHash}`,
          `JSON target whole-file SHA-256: ${json.wholeFileHash}`,
          assertionLine('JSON target', json.assertion),
        ]
      : []),
    ...(database
      ? [
          `Database policy forecast review SHA-256: ${database.reviewContentHash}${database.label ? ` (${escape(database.label)})` : ''}. Resource impact uses this forecast.`,
        ]
      : json
        ? ['The catalog projection uses the planned JSON target decisions.']
        : []),
  ];
}

/** Always available, including when no report files are selected. Counts describe this frozen revision. */
export function licenseInlineSummary(model: LicenseReportModel): string {
  const { impact } = model;
  const database = impact.context.kind === 'database';
  return [
    impact.context.disclaimer,
    `Classification decisions: allowed ${impact.classificationTotals.allowed}, forbidden ${impact.classificationTotals.forbidden}, unknown ${impact.classificationTotals.unknown}.`,
    `${database ? 'Projected status after ordinary derived sync' : 'Artifact catalog decisions'}: allowed ${impact.totals.allowed}, forbidden ${impact.totals.forbidden}, unknown ${impact.totals.unknown}.`,
    `Projected status changes: ${impact.statusChangeCount ?? 'unavailable'}; new catalog records: ${database ? impact.newCatalogRows.length : 'unavailable'}; notice changes: ${database ? impact.noticeChanges.length : 'unavailable'}; unchanged status/notice: ${impact.unchanged ?? 'unavailable'}.`,
    `TTS eligibility gains: ${impact.ttsGains ?? 'unavailable'}; losses: ${impact.ttsLosses ?? 'unavailable'}; normalization collisions: ${impact.collisions.length}; missing exact classifications: ${impact.missingClassifications.length}.`,
    `Recorded evidence diagnostics: ${impact.diagnostics.cacheHits} cache hits; ${impact.diagnostics.newCalls} provider calls.`,
    ...(impact.preservationWarning
      ? [impact.preservationWarning, `Preservation disagreements: ${impact.disagreements.length}.`]
      : []),
    ...licenseReportRevisionLines(model),
  ].join('\n');
}

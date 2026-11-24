import { describe, expect, it } from 'vitest';

import v2 from './__fixtures__/license-artifact-v2.json';
import v3 from './__fixtures__/license-artifact-v3.json';
import { assessedLicenseRow } from './classification/license-assessment';
import { applyLicenseReviewEdit } from './classification/license-workflow-review';
import {
  attestLicenseArtifact,
  checkLicenseArtifactReview,
  overrideLicenseClassification,
  recordHumanLicenseDecision,
  serializeLicenseArtifact,
} from './license-artifact';
import { computeLicenseReviewHash } from './license-artifact.hash';
import { parseLicenseArtifact } from './license-artifact.schemas';
import { makeLicenseArtifact, REVIEWER } from './license-artifact.test-fixtures';
import { createLicenseClassifier } from './license-classifier';

const now = '2026-11-24T12:00:00.000Z';
const later = '2026-11-24T13:00:00.000Z';

describe.each([v2, v3])('original v$schemaVersion hash domain', (original) => {
  it('migrates the original assertion, keeping all promoted extension names reversible', () => {
    const upgraded = parseLicenseArtifact(original);
    expect(upgraded.schemaVersion).toBe(4);
    expect(upgraded.attestation).toBeUndefined();
    expect(upgraded.historicalAttestations?.at(-1)).toEqual({
      ...original.attestation,
      schemaVersion: original.schemaVersion,
      hashDomainVersion: original.schemaVersion,
    });
    if (original.schemaVersion === 3)
      expect(upgraded.historicalAttestations?.[0]).toEqual(original.historicalAttestation);
    const [row] = upgraded.classifications;
    expect(row.reviewedBy).toBe(original === v2 ? null : 'Original author');
    expect(row.reviewComment).toBeUndefined();
    expect(row.reviewHistory).toBeUndefined();
    expect(row.extra).toEqual(['retained']);
    expect(row.migrationExtensions).toEqual({
      schemaVersion: original.schemaVersion,
      fields: {
        reviewHistory: 'legacy-extension',
        rowNoteProvenance: 'legacy-extension',
        reviewComment: { extension: 1 },
        migrationExtensions: { already: true },
        ...(original === v2 ? { reviewState: 'custom', reviewedBy: 'extension-only' } : {}),
      },
    });
    expect(upgraded.migrationExtensions).toEqual({
      schemaVersion: original.schemaVersion,
      fields: {
        historicalAttestations: { extension: true },
        migrationExtensions: 'older envelope',
        ...(original === v2 ? { historicalAttestation: 'unowned singular' } : {}),
      },
    });
    expect(parseLicenseArtifact(JSON.parse(serializeLicenseArtifact(upgraded).bytes))).toEqual(
      upgraded
    );
  });

  it('rejects changed original owned content and a mismatched original assertion', () => {
    const tampered = structuredClone(original);
    tampered.classifications[0].rowNote += ' updated';
    expect(checkLicenseArtifactReview(tampered)).toMatchObject({
      status: 'invalid',
      reason: expect.stringContaining('hash mismatch'),
    });
    expect(() =>
      parseLicenseArtifact({
        ...original,
        attestation: { ...original.attestation, reviewContentHash: '0'.repeat(64) },
      })
    ).toThrow('another revision');
    if (original === v3) {
      const changed = structuredClone(v3);
      changed.classifications[0].reviewedBy = 'Someone else';
      expect(() => parseLicenseArtifact(changed)).toThrow('hash mismatch');
    }
  });

  it('archives labeled legacy fields before a new reviewer marks an unknown without comment', () => {
    const artifact = parseLicenseArtifact(original);
    const [prior] = artifact.classifications;
    const reviewed = recordHumanLicenseDecision(
      artifact,
      prior.normalizedText,
      'unknown',
      {},
      'New reviewer',
      now
    );
    expect(reviewed.classifications[0]).toMatchObject({
      rationale: '',
      reviewedBy: 'New reviewer',
      decisionAt: now,
      reviewHistory: [
        {
          status: 'unknown',
          source: 'manual',
          rationale: 'Historic rationale',
          rowNote: 'Distinct note',
          reviewComment: null,
          reviewedBy: prior.reviewedBy,
          decisionAt: prior.decisionAt,
          humanReviewedAt: prior.humanReviewedAt,
          reviewState: prior.reviewState,
        },
      ],
    });
    expect(reviewed.classifications[0].rowNote).toBeUndefined();
    expect(reviewed.classifications[0].reviewComment).toBeUndefined();
    expect(checkLicenseArtifactReview(attestLicenseArtifact(reviewed, REVIEWER)).status).toBe(
      'ready'
    );
  });
});

it('owns ordered history and current comment while preserving model evidence across repeated human decisions', () => {
  const base = makeLicenseArtifact();
  const model = base.classifications[1];
  const first = recordHumanLicenseDecision(
    base,
    model.normalizedText,
    'forbidden',
    { reviewComment: 'Ask publisher' },
    'First',
    now
  );
  const signed = attestLicenseArtifact(first, REVIEWER);
  expect(signed.classifications[1].reviewHistory).toBeUndefined();
  const tampered = structuredClone(signed);
  tampered.classifications[1].reviewComment = 'Edited';
  const checked = checkLicenseArtifactReview(tampered);
  expect(checked.status).toBe('review-required');
  if (checked.status === 'review-required') expect(checked.artifact.attestation).toBeUndefined();
  const second = recordHumanLicenseDecision(
    signed,
    model.normalizedText,
    model.status,
    { reviewComment: '' },
    'Second',
    later
  );
  const row = second.classifications[1];
  expect(second.attestation).toBeUndefined();
  expect(row.reviewComment).toBeUndefined();
  expect(row.reviewHistory).toMatchObject([
    { reviewedBy: 'First', reviewComment: 'Ask publisher', status: 'forbidden', rationale: null },
  ]);
  expect(row.automaticDecision).toEqual({
    source: model.source,
    status: model.status,
    rationale: model.rationale,
  });
  expect(row.samples).toEqual(model.samples);
  const third = recordHumanLicenseDecision(
    second,
    model.normalizedText,
    model.status,
    { reviewComment: 'Checked' },
    'Third',
    later
  );
  const reordered = structuredClone(third);
  reordered.classifications[1].reviewHistory!.reverse();
  expect(computeLicenseReviewHash(reordered)).not.toBe(third.reviewContentHash);
  for (const field of [
    'rationale',
    'reviewComment',
    'reviewedBy',
    'rowNote',
    'humanReviewedAt',
    'decisionAt',
  ] as const) {
    const changed = structuredClone(third);
    changed.classifications[1].reviewHistory![0][field] = 'alteration';
    expect(computeLicenseReviewHash(changed)).not.toBe(third.reviewContentHash);
  }
  const unchanged = structuredClone(third);
  unchanged.classifications[1].migrationExtensions = { reviewComment: 'unowned' };
  expect(computeLicenseReviewHash(unchanged)).toBe(third.reviewContentHash);
});

it('archives human evidence when a completed rule reassessment replaces the decision', async () => {
  const base = makeLicenseArtifact();
  const rule = base.classifications[0];
  const reviewed = recordHumanLicenseDecision(
    base,
    rule.normalizedText,
    'allowed',
    { reviewComment: 'Exception' },
    'Reviewer',
    now
  );
  const result = assessedLicenseRow({
    normalizedText: rule.normalizedText,
    exampleNotice: rule.exampleNotice!,
    proposal: await createLicenseClassifier({ model: 'google:fixture', apiKey: '', noCache: true })(
      rule.exampleNotice!
    ),
    classificationRun: base.classificationRun,
    previous: reviewed.classifications[0],
    now: () => later,
  });
  expect(result.reviewComment).toBeUndefined();
  expect(result.reviewedBy).toBeNull();
  expect(result.reviewHistory).toMatchObject([
    { status: 'allowed', reviewedBy: 'Reviewer', reviewComment: 'Exception', decisionAt: now },
  ]);
});

it('retains the signed v3 decision while two anonymous notes replace its legacy note', () => {
  const base = parseLicenseArtifact(v3);
  const [original] = base.classifications;
  const edit = (artifact: typeof base, note: string) =>
    applyLicenseReviewEdit(
      artifact,
      {
        kind: 'unknown-note',
        normalizedText: original.normalizedText,
        note,
      },
      () => {
        throw new Error('A note edit must not request a review time');
      }
    ).artifact;
  const first = edit(base, 'First anonymous note');
  const second = edit(first, 'Second anonymous note');
  const [row] = second.classifications;
  expect(row).toMatchObject({
    reviewedBy: 'Original author',
    decisionAt: original.decisionAt,
    humanReviewedAt: original.humanReviewedAt,
    rationale: 'Historic rationale',
    rowNote: 'Second anonymous note',
    rowNoteProvenance: {
      originalRowNote: 'Distinct note',
      priorAnonymousNotes: ['First anonymous note'],
      author: null,
    },
  });
  expect(row.reviewHistory).toBeUndefined();
  expect(second.historicalAttestations).toEqual(base.historicalAttestations);
  const unchanged = edit(second, 'Second anonymous note');
  expect(unchanged.reviewContentHash).toBe(second.reviewContentHash);
  const signed = attestLicenseArtifact(second, REVIEWER);
  const changed = structuredClone(signed);
  changed.classifications[0].rowNoteProvenance!.priorAnonymousNotes[0] = 'Changed';
  expect(checkLicenseArtifactReview(changed)).toMatchObject({
    status: 'review-required',
    artifact: { reviewState: 'incomplete' },
  });
  const next = recordHumanLicenseDecision(
    signed,
    row.normalizedText,
    'allowed',
    {},
    'New reviewer',
    later
  );
  expect(next.classifications[0].rowNoteProvenance).toBeUndefined();
  expect(next.classifications[0].reviewHistory).toMatchObject([
    {
      reviewedBy: 'Original author',
      rowNote: row.rowNote,
      rowNoteProvenance: row.rowNoteProvenance,
    },
  ]);
  expect(parseLicenseArtifact(JSON.parse(serializeLicenseArtifact(next).bytes))).toEqual(next);
});

it.each([
  { source: 'rule', reviewState: 'llm_reviewed' },
  { source: 'table', reviewState: 'llm_reviewed' },
  { source: 'rule', rationale: null },
  { source: 'table', rationale: '' },
  { source: 'gemini', rationale: '   ' },
  { reviewState: 'unreviewed', reviewedBy: 'Invented' },
  { reviewState: 'llm_reviewed', humanReviewedAt: now },
  { reviewState: 'unreviewed', reviewComment: 'Invented' },
  { reviewState: 'human_reviewed', reviewedBy: 'Actor', humanReviewedAt: now, decisionAt: later },
  { reviewState: 'unreviewed', decisionAt: '2026-11-24T12:00:00Z' },
] as const)('rejects inconsistent historic provenance on import and assertion: %j', (mutation) => {
  const base = parseLicenseArtifact(v2);
  const revised = recordHumanLicenseDecision(
    base,
    base.classifications[0].normalizedText,
    'allowed',
    {},
    'Reviewer',
    now
  );
  // A legitimate manual legacy snapshot has unknown attribution and no invented clock.
  expect(checkLicenseArtifactReview(revised).status).not.toBe('invalid');
  Object.assign(revised.classifications[0].reviewHistory![0], mutation);
  revised.reviewContentHash = computeLicenseReviewHash(revised);
  expect(checkLicenseArtifactReview(revised).status).toBe('invalid');
  expect(() => attestLicenseArtifact(revised, REVIEWER)).toThrow();
});

it('preserves an anonymous manual decision based on a recorded model review', () => {
  const base = makeLicenseArtifact();
  const key = base.classifications[1].normalizedText;
  const legacy = overrideLicenseClassification(
    base,
    key,
    'unknown',
    'Legacy manual reason'
  ).artifact;
  const reviewed = recordHumanLicenseDecision(legacy, key, 'allowed', {}, 'Reviewer', now);
  expect(reviewed.classifications[1].reviewHistory).toMatchObject([
    {
      source: 'manual',
      reviewState: 'llm_reviewed',
      reviewedBy: null,
      humanReviewedAt: null,
      rationale: 'Legacy manual reason',
    },
  ]);
  expect(checkLicenseArtifactReview(attestLicenseArtifact(reviewed, REVIEWER)).status).toBe(
    'ready'
  );
});

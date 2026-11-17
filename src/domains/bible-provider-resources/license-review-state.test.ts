import { describe, expect, it } from 'vitest';

import {
  checkLicenseArtifactReview,
  recordHumanLicenseDecision,
  reviseLicenseArtifact,
} from './license-artifact';
import { makeLicenseArtifact } from './license-artifact.test-fixtures';

describe('row review events', () => {
  const at = '2026-11-17T12:34:56.789Z';

  it('records a named same-status human event while retaining model evidence', () => {
    const artifact = makeLicenseArtifact();
    const original = artifact.classifications[1];
    const reviewed = recordHumanLicenseDecision(
      artifact,
      original.normalizedText,
      original.status,
      'Confirmed model answer',
      'Reviewer',
      at
    );
    const row = reviewed.classifications[1];
    expect(row).toMatchObject({
      status: original.status,
      reviewState: 'human_reviewed',
      reviewedBy: 'Reviewer',
      humanReviewedAt: at,
      decisionAt: at,
      automaticDecision: { source: 'gemini', status: original.status },
    });
    expect(row.samples).toEqual(original.samples);
    expect(checkLicenseArtifactReview(reviewed).status).not.toBe('invalid');
  });

  it('accepts human-first decisions without invented automatic evidence', () => {
    const initial = reviseLicenseArtifact(makeLicenseArtifact(), (draft) => {
      const row = draft.classifications[2];
      row.source = 'manual';
      delete row.automaticDecision;
      row.reviewState = 'unreviewed';
    });
    const row = initial.classifications[2];
    const reviewed = recordHumanLicenseDecision(
      initial,
      row.normalizedText,
      'allowed',
      'Direct licence confirmation',
      'Reviewer',
      at
    );
    expect(reviewed.classifications[2].automaticDecision).toBeUndefined();
    expect(reviewed.classifications[2].reviewState).toBe('human_reviewed');
  });

  it('rejects mismatched human attribution and noncanonical time', () => {
    const artifact = makeLicenseArtifact();
    const key = artifact.classifications[0].normalizedText;
    expect(() =>
      recordHumanLicenseDecision(
        artifact,
        key,
        'allowed',
        'Confirmed',
        'Reviewer',
        '2026-11-17T12:34:56Z'
      )
    ).toThrow('canonical');
    const inconsistent = structuredClone(artifact);
    inconsistent.classifications[0].reviewedBy = 'Unbound reviewer';
    expect(checkLicenseArtifactReview(inconsistent).status).toBe('invalid');
  });
});

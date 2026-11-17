import { describe, expect, it, vi } from 'vitest';

import { reviseLicenseArtifact } from './license-artifact';
import { makeLicenseArtifact } from './license-artifact.test-fixtures';
import { makeLicenseImpactFixture } from './license-report.test-fixtures';
import { runLicenseReview } from './license-review';
import { makeLicenseReviewConfig, scriptedLicenseReviewIo } from './license-review.test-fixtures';

describe('cLI row navigation and named review', () => {
  it('searches by row number, displays rule evidence, and records a named decision', async () => {
    const original = makeLicenseArtifact();
    const io = scriptedLicenseReviewIo([
      'R',
      '1',
      'allowed',
      'Rights holder granted this use.',
      'Named reviewer',
      '',
      'W',
      'y',
    ]);
    const regenerateReports = vi.fn(async () => {});
    const result = await runLicenseReview({
      artifact: original,
      config: makeLicenseReviewConfig(),
      io,
      regenerateReports,
    });
    expect(result.writeIntent).toBe(true);
    expect(result.artifact.classifications[0]).toMatchObject({
      status: 'allowed',
      source: 'manual',
      reviewState: 'human_reviewed',
      reviewedBy: 'Named reviewer',
      automaticDecision: { status: 'forbidden', source: 'rule' },
      rule: original.classifications[0].rule,
    });
    expect(regenerateReports).toHaveBeenCalledTimes(2);
    const messages = io.write.mock.calls.map(([message]) => message).join('\n');
    expect(messages).toContain('WARNING:');
    expect(messages).toContain('All rights reserved');
    expect(messages).toContain('Bible ID 1');
  });

  it('rejects a blank rationale or reviewer without changing the row', async () => {
    const original = makeLicenseArtifact();
    const io = scriptedLicenseReviewIo([
      'R',
      '1',
      'allowed',
      ' ',
      '1',
      'allowed',
      'Reason supplied',
      ' ',
      '',
      'Q',
    ]);
    const result = await runLicenseReview({
      artifact: original,
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result.artifact.reviewContentHash).toBe(original.reviewContentHash);
    expect(io.write.mock.calls.map(([message]) => message).join('\n')).toContain(
      'No reviewer name supplied'
    );
  });

  it('permits same-status human confirmation and keeps automatic evidence', async () => {
    const original = makeLicenseArtifact();
    const io = scriptedLicenseReviewIo([
      'R',
      'Bible 2',
      '1',
      'allowed',
      'Confirmed permitted use.',
      'Reviewer B',
      '',
      'Q',
    ]);
    const result = await runLicenseReview({
      artifact: original,
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result.artifact.classifications[1]).toMatchObject({
      status: 'allowed',
      reviewState: 'human_reviewed',
      reviewedBy: 'Reviewer B',
      automaticDecision: { status: 'allowed', source: 'gemini' },
      samples: original.classifications[1].samples,
    });
    expect(result.artifact.classifications[1].humanReviewedAt).toMatch(/Z$/);
  });

  it('leaves an unknown without a note and saves without bulk attestation', async () => {
    const original = reviseLicenseArtifact(makeLicenseArtifact(), (draft) => {
      delete draft.classifications[2].rowNote;
    });
    const io = scriptedLicenseReviewIo(['R', '/unknown', '1', '', '', '', 'W', 'y']);
    const result = await runLicenseReview({
      artifact: original,
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result.writeIntent).toBe(true);
    expect(result.artifact.classifications[2].rowNote).toBeUndefined();
    expect(result.artifact.classifications[2].reviewState).toBe('unreviewed');
    expect(result.artifact.attestation).toBeUndefined();
  });

  it('updates an optional unknown note without creating a human review event', async () => {
    const original = makeLicenseArtifact();
    const io = scriptedLicenseReviewIo(['R', '/unknown', '1', '', 'Clarifying note.', '', 'Q']);
    const result = await runLicenseReview({
      artifact: original,
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result.artifact.classifications[2].rowNote).toBe('Clarifying note.');
    expect(result.artifact.classifications[2].reviewState).toBe(
      original.classifications[2].reviewState
    );
    expect(result.artifact.classifications[2].decisionAt).toBe(
      original.classifications[2].decisionAt
    );
  });

  it('searches actual database membership rather than stale catalog names', async () => {
    const { artifact, database } = makeLicenseImpactFixture();
    database.resources[1].name = 'Production-only name';
    const io = scriptedLicenseReviewIo(['R', 'Production-only name', '1', '', '', 'Q']);
    await runLicenseReview({
      artifact,
      config: makeLicenseReviewConfig({ source: 'database', database }),
      io,
    });
    expect(io.write.mock.calls.map(([message]) => message).join('\n')).toContain(
      'Production-only name'
    );
  });

  it('offers explicit rule and model selections after row navigation', async () => {
    const original = makeLicenseArtifact();
    const reassess = vi.fn(async () => null);
    const io = scriptedLicenseReviewIo(['R', '1', '/rule', '1', '/model', '', 'Q']);
    await runLicenseReview({ artifact: original, config: makeLicenseReviewConfig(), io, reassess });
    expect(reassess).toHaveBeenNthCalledWith(1, original.classifications[0].normalizedText, 'rule');
    expect(reassess).toHaveBeenNthCalledWith(
      2,
      original.classifications[0].normalizedText,
      'model'
    );
  });
});

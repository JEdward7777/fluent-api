import { describe, expect, it, vi } from 'vitest';

import type { LicenseReportBundle } from './license-reports';

import { overrideLicenseClassification, reviseLicenseArtifact } from './license-artifact';
import { makeLicenseArtifact, REVIEWER } from './license-artifact.test-fixtures';
import { makeLicenseImpactFixture } from './license-report.test-fixtures';
import { runLicenseReview } from './license-review';
import { makeLicenseReviewConfig, scriptedLicenseReviewIo } from './license-review.test-fixtures';

describe('single-view search, filter and reasoned row review', () => {
  it('shows ARR evidence, warns before reason, preserves the proposal, then regenerates edits and final attestation', async () => {
    const original = makeLicenseArtifact();
    const io = scriptedLicenseReviewIo([
      'R',
      '1',
      'allowed',
      'Explicit rights-holder permission was reviewed.',
      '',
      'W',
      'y',
      REVIEWER.reviewedBy,
      REVIEWER.reviewReason,
      'y',
    ]);
    const regenerateReports = vi.fn(async (_report: LicenseReportBundle) => {});
    const result = await runLicenseReview({
      artifact: original,
      config: makeLicenseReviewConfig(),
      io,
      regenerateReports,
      now: () => REVIEWER.reviewedAt,
    });
    expect(result.writeIntent).toBe(true);
    expect(result.artifact.classifications[0]).toMatchObject({
      status: 'allowed',
      source: 'manual',
      automaticDecision: { status: 'forbidden', source: 'rule' },
      rule: original.classifications[0].rule,
    });
    expect(regenerateReports).toHaveBeenCalledTimes(3);
    const [initial, edited, attested] = regenerateReports.mock.calls.map(([report]) => report);
    expect(initial.reviewContentHash).not.toBe(edited.reviewContentHash);
    expect(edited.reviewContentHash).toBe(attested.reviewContentHash);
    expect(edited.wholeFileHash).not.toBe(attested.wholeFileHash);
    const warningIndex = io.write.mock.calls.findIndex(([message]) =>
      message.startsWith('WARNING:')
    );
    const reasonIndex = io.ask.mock.calls.findIndex(([message]) =>
      message.startsWith('Reason for')
    );
    expect(io.write.mock.invocationCallOrder[warningIndex]).toBeLessThan(
      io.ask.mock.invocationCallOrder[reasonIndex]
    );
    const evidence = io.write.mock.calls.map(([message]) => message).join('\n');
    expect(evidence).toContain('Raw notice:');
    expect(evidence).toContain('All rights reserved');
    expect(evidence).toContain('Bible ID 1');
    expect(evidence).toContain('Rule all-rights-reserved');
  });
  it('does not change a row when an override reason is blank', async () => {
    const original = makeLicenseArtifact();
    const io = scriptedLicenseReviewIo(['R', '1', 'allowed', ' ', '', 'Q']);
    const regenerateReports = vi.fn(async (_report: LicenseReportBundle) => {});
    const result = await runLicenseReview({
      artifact: original,
      config: makeLicenseReviewConfig(),
      io,
      regenerateReports,
    });
    expect(result.artifact.reviewContentHash).toBe(original.reviewContentHash);
    expect(result.artifact.classifications[0].status).toBe('forbidden');
    expect(regenerateReports).toHaveBeenCalledOnce();
  });
  it('searches affected Bible identities and shows every model vote inline when no report format is selected', async () => {
    const io = scriptedLicenseReviewIo([
      'R',
      'Bible 2',
      '1',
      'forbidden',
      'A reasoned human decision.',
      '',
      'Q',
    ]);
    const result = await runLicenseReview({
      artifact: makeLicenseArtifact(),
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result.reports.reports).toEqual([]);
    expect(result.artifact.classifications[1]).toMatchObject({
      status: 'forbidden',
      source: 'manual',
      automaticDecision: { status: 'allowed', source: 'gemini' },
    });
    const messages = io.write.mock.calls.map(([message]) => message).join('\n');
    expect(messages).toContain('Recorded model vote google:recorded-model-a, sample 1: allowed');
    expect(messages).toContain('Recorded model vote google:recorded-model-b, sample 3: allowed');
    expect(messages).toContain('The stated use is permitted.');
    expect(messages).toContain('Affected Bibles (1)');
  });
  it('records a human unknown disposition and its row note while preserving every original model vote', async () => {
    const original = makeLicenseArtifact();
    const io = scriptedLicenseReviewIo([
      'R',
      '2',
      'unknown',
      'The recorded evidence remains ambiguous after review.',
      '',
      'Q',
    ]);
    const result = await runLicenseReview({
      artifact: original,
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result.artifact.classifications[1]).toMatchObject({
      status: 'unknown',
      source: 'manual',
      rowNote: 'The recorded evidence remains ambiguous after review.',
      automaticDecision: { status: 'allowed', source: 'gemini' },
      samples: original.classifications[1].samples,
    });
  });

  it('shows the preserved automatic ARR evidence on an already-manual row', async () => {
    const base = makeLicenseArtifact();
    const manual = overrideLicenseClassification(
      base,
      base.classifications[0].normalizedText,
      'allowed',
      'Earlier human permission review.'
    ).artifact;
    const io = scriptedLicenseReviewIo(['R', '1', '', '', 'Q']);
    await runLicenseReview({ artifact: manual, config: makeLicenseReviewConfig(), io });
    const messages = io.write.mock.calls.map(([message]) => message).join('\n');
    expect(messages).toContain('Preserved automatic proposal: forbidden (rule)');
    expect(messages).toContain('matched excerpt "All rights reserved"');
    expect(messages).toContain('Raw notice:');
  });
  it('retains authoritative unknown without inference and adds its required human row note', async () => {
    const original = reviseLicenseArtifact(makeLicenseArtifact(), (draft) => {
      delete draft.classifications[2].rowNote;
    });
    const io = scriptedLicenseReviewIo([
      'R',
      '/unknown',
      '1',
      '',
      'Unresolved; retained after review.',
      '',
      'W',
      'y',
      REVIEWER.reviewedBy,
      REVIEWER.reviewReason,
      'y',
    ]);
    const result = await runLicenseReview({
      artifact: original,
      config: makeLicenseReviewConfig(),
      io,
      now: () => REVIEWER.reviewedAt,
    });
    expect(result.artifact.classifications[2]).toMatchObject({
      source: 'table',
      status: 'unknown',
      samples: [],
      rowNote: 'Unresolved; retained after review.',
    });
    expect(result.reviewStatus).toBe('ready');
  });
  it('does not complete JSON with an unknown lacking a note even after accepting review responsibility', async () => {
    const original = reviseLicenseArtifact(makeLicenseArtifact(), (draft) => {
      delete draft.classifications[2].rowNote;
    });
    const io = scriptedLicenseReviewIo(['R', '/unknown', '1', '', '', '', 'W', 'y', 'Q']);
    const result = await runLicenseReview({
      artifact: original,
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result.writeIntent).toBe(false);
    expect(result.artifact.attestation).toBeUndefined();
    expect(io.ask.mock.calls.some(([question]) => question.startsWith('Reviewer identity'))).toBe(
      false
    );
    expect(
      io.write.mock.calls.some(([message]) => message.includes('Every retained unknown needs'))
    ).toBe(true);
  });
  it('searches and displays the same frozen database-only affected membership as report inventory before and after edits', async () => {
    const { artifact, database } = makeLicenseImpactFixture();
    database.resources.push({
      provider: 'dbl',
      externalId: 'production-only',
      bibleId: 100,
      name: 'Unique production-only Bible',
      abbreviation: 'PROD',
      rawNotice: artifact.catalog[0].rawNotice!.replace('2026', '2024'),
      ttsLicenseStatus: 'forbidden',
    });
    const io = scriptedLicenseReviewIo([
      'R',
      'Unique production-only Bible',
      '1',
      'allowed',
      'Reviewed permission applies to all matching notices.',
      '1',
      '',
      '',
      'Q',
    ]);
    const ask = io.ask.getMockImplementation()!;
    io.ask.mockImplementation(async (question) => {
      // The live caller-owned context may change; the resolved review snapshot must not.
      database.resources[database.resources.length - 1].name = 'Changed outside the review';
      return ask(question);
    });
    const result = await runLicenseReview({
      artifact,
      config: makeLicenseReviewConfig({ source: 'database', database }),
      io,
    });
    const inventory = result.reports.model.inventory.find(
      (row) => row.normalizedText === artifact.classifications[0].normalizedText
    )!;
    expect(inventory.bibles).toHaveLength(3);
    expect(inventory.bibles.some((bible) => bible.externalId === 'production-only')).toBe(true);
    expect(result.artifact.classifications[0].status).toBe('allowed');
    const details = io.write.mock.calls
      .map(([message]) => message)
      .filter((message) => message.includes('Affected Bibles (3)'));
    expect(details).toHaveLength(2);
    for (const detail of details) {
      expect(detail).toContain('Unique production-only Bible');
      expect(detail).toContain('dbl:production-only; Bible ID 100');
      expect(detail).toContain('2024');
      expect(detail).not.toContain('Changed outside the review');
    }
  });

  it.each([null, 1234])(
    'searches the actual loaded Bible name and ID when the artifact ID is %s',
    async (artifactId) => {
      const fixture = makeLicenseImpactFixture();
      const artifact = reviseLicenseArtifact(fixture.artifact, (draft) => {
        draft.catalog[1].bibleId = artifactId;
      });
      fixture.database.resources[1].bibleId = 9876;
      fixture.database.resources[1].name = 'Actual loaded Bible';
      fixture.database.resources[1].abbreviation = 'ACTUAL';
      const io = scriptedLicenseReviewIo([
        'R',
        'Actual loaded Bible',
        '1',
        '',
        '/search 9876',
        '1',
        '',
        '',
        'Q',
      ]);
      const result = await runLicenseReview({
        artifact,
        config: makeLicenseReviewConfig({ source: 'database', database: fixture.database }),
        io,
      });
      const details = io.write.mock.calls
        .map(([message]) => message)
        .filter(
          (message) => message.includes('Affected Bibles') && message.includes('Bible ID 9876')
        );
      expect(details).toHaveLength(2);
      for (const detail of details) {
        expect(detail).toContain('Actual loaded Bible');
        expect(detail).toContain('Recorded model vote');
      }
      expect(
        io.write.mock.calls.some(([message]) => message.includes('No row with that number'))
      ).toBe(false);
      expect(
        result.reports.model.inventory.find(
          (row) => row.normalizedText === artifact.classifications[1].normalizedText
        )!.bibles
      ).toMatchObject([{ bibleId: 9876, name: 'Actual loaded Bible', abbreviation: 'ACTUAL' }]);
      expect(result.artifact.catalog[1].bibleId).toBe(artifactId);
      expect(result.artifact.catalog[1].name).toBe('Bible 2');
      expect(result.writeIntent).toBe(false);
    }
  );

  it('keeps invalid filters/row selections/decisions in the same view without applying changes', async () => {
    const original = makeLicenseArtifact();
    const io = scriptedLicenseReviewIo(['R', '/invalid', '999', '1', 'invalid', '', 'Q']);
    const result = await runLicenseReview({
      artifact: original,
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result.artifact.reviewContentHash).toBe(original.reviewContentHash);
    expect(result.writeIntent).toBe(false);
    expect(io.write.mock.calls.some(([message]) => message.includes('Invalid decision'))).toBe(
      true
    );
  });
});

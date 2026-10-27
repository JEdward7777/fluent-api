import { describe, expect, it, vi } from 'vitest';

import type { LicenseReportBundle } from './license-reports';

import { attestLicenseArtifact, serializeLicenseArtifact } from './license-artifact';
import { makeLicenseArtifact, REVIEWER } from './license-artifact.test-fixtures';
import { runLicenseReview } from './license-review';
import { makeLicenseReviewConfig, scriptedLicenseReviewIo } from './license-review.test-fixtures';

describe('frozen interactive license review controller', () => {
  it('writes only after explicit exact-revision attestation and final confirmation; regenerates final metadata bytes', async () => {
    const original = makeLicenseArtifact();
    const before = structuredClone(original);
    const io = scriptedLicenseReviewIo(['W', 'y', REVIEWER.reviewedBy, REVIEWER.reviewReason, 'y']);
    const regenerateReports = vi.fn(async (_report: LicenseReportBundle) => {});
    const result = await runLicenseReview({
      artifact: original,
      config: makeLicenseReviewConfig({ formats: 'markdown,html' }),
      io,
      regenerateReports,
      now: () => REVIEWER.reviewedAt,
    });
    expect(result).toMatchObject({
      action: 'write',
      writeIntent: true,
      reviewStatus: 'ready',
      attestationDeclined: false,
    });
    expect(regenerateReports).toHaveBeenCalledTimes(2);
    const [initial, attested] = regenerateReports.mock.calls.map(([report]) => report);
    expect(initial.reviewContentHash).toBe(attested.reviewContentHash);
    expect(initial.wholeFileHash).not.toBe(attested.wholeFileHash);
    expect(attested.artifactBytes).toBe(serializeLicenseArtifact(result.artifact).bytes);
    expect(result.reports).toEqual(attested);
    expect(io.ask.mock.calls.at(-1)![0]).toContain(attested.wholeFileHash);
    expect(io.ask.mock.calls.at(-1)![0]).toContain(result.artifact.reviewContentHash);
    expect(io.write.mock.calls.some(([message]) => message.includes('file://'))).toBe(true);
    expect(original).toEqual(before);
    expect(Object.isFrozen(result.artifact.classifications[0])).toBe(true);
  });
  it('uses an existing exact attestation but still requires final write confirmation', async () => {
    const io = scriptedLicenseReviewIo(['W', 'y']);
    const result = await runLicenseReview({
      artifact: attestLicenseArtifact(makeLicenseArtifact(), REVIEWER),
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result.writeIntent).toBe(true);
    expect(io.ask.mock.calls.map(([question]) => question).join('\n')).not.toContain(
      'Reviewer identity'
    );
    expect(io.ask).toHaveBeenCalledTimes(2);
  });
  it('defaults final confirmation to no and returns without write intent after quit', async () => {
    const io = scriptedLicenseReviewIo(['W', '', '', 'Q']);
    const result = await runLicenseReview({
      artifact: makeLicenseArtifact(),
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result).toMatchObject({ action: 'quit', writeIntent: false });
    expect(io.write.mock.calls.some(([message]) => message.includes('Write canceled'))).toBe(true);
  });
  it('can explicitly save incomplete JSON without inventing a reviewer', async () => {
    const io = scriptedLicenseReviewIo(['W', 'n', 'y']);
    const result = await runLicenseReview({
      artifact: makeLicenseArtifact(),
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result).toMatchObject({
      writeIntent: true,
      attestationDeclined: true,
      reviewStatus: 'review-required',
      artifact: { reviewState: 'incomplete' },
    });
    expect(result.artifact.attestation).toBeUndefined();
  });
  it.each(['database', 'both'] as const)(
    'blocks JSON to %s on declined attestation without a doomed write prompt',
    async (destination) => {
      const io = scriptedLicenseReviewIo(['W', 'n']);
      const config = makeLicenseReviewConfig({
        destination,
        database: { label: 'Explicit empty database snapshot', resources: [] },
      });
      const result = await runLicenseReview({ artifact: makeLicenseArtifact(), config, io });
      expect(result).toMatchObject({
        action: 'review-required',
        writeIntent: false,
        attestationDeclined: true,
      });
      expect(io.ask).toHaveBeenCalledTimes(2);
      expect(
        io.write.mock.calls.some(([message]) => message.includes('no database rows will change'))
      ).toBe(true);
    }
  );
  it('keeps inline decision/impact review available with formats none', async () => {
    const io = scriptedLicenseReviewIo(['Q']);
    const result = await runLicenseReview({
      artifact: makeLicenseArtifact(),
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result.reports.reports).toEqual([]);
    const summary = io.write.mock.calls.map(([message]) => message).join('\n');
    expect(summary).toContain(
      'Production impact is unavailable because no database context was supplied.'
    );
    expect(summary).toContain('Classification decisions: allowed 1, forbidden 1, unknown 1.');
    expect(summary).toContain('TTS eligibility gains: unavailable');
    expect(summary).toContain(result.artifact.reviewContentHash);
    expect(io.write.mock.invocationCallOrder[0]).toBeLessThan(io.ask.mock.invocationCallOrder[0]);
  });
  it.each([{ interactive: false }, { yes: true }])(
    'does not enter UI noninteractively or with --yes: %j',
    async (override) => {
      const io = scriptedLicenseReviewIo([]);
      await expect(
        runLicenseReview({
          artifact: 'must not be read or analyzed',
          config: makeLicenseReviewConfig(override),
          io,
        })
      ).rejects.toThrow('Interactive review');
      expect(io.ask).not.toHaveBeenCalled();
      expect(io.write).not.toHaveBeenCalled();
    }
  );
  it('requires actual database context for a selected database source or destination', async () => {
    const io = scriptedLicenseReviewIo([]);
    await expect(
      runLicenseReview({
        artifact: makeLicenseArtifact(),
        config: makeLicenseReviewConfig({ source: 'database' }),
        io,
      })
    ).rejects.toThrow('actual impact context');
    expect(io.ask).not.toHaveBeenCalled();
  });
  it('requires nonblank reviewer identity and reason instead of accepting an unnamed review', async () => {
    const io = scriptedLicenseReviewIo(['W', 'y', ' ', REVIEWER.reviewReason, 'Q']);
    const result = await runLicenseReview({
      artifact: makeLicenseArtifact(),
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result.writeIntent).toBe(false);
    expect(result.artifact.attestation).toBeUndefined();
    expect(
      io.write.mock.calls.some(([message]) =>
        message.includes('Identity and review reason are required')
      )
    ).toBe(true);
  });
  it('detaches configuration and analyzed source data before any IO and returns an immutable revision', async () => {
    const original = makeLicenseArtifact();
    const config = makeLicenseReviewConfig();
    const io = scriptedLicenseReviewIo(['W', 'n', 'y']);
    const ask = io.ask.getMockImplementation()!;
    io.ask.mockImplementation(async (question) => {
      original.catalog[0].name = 'Externally mutated source';
      original.classifications[0].rationale = 'Changed without rereading';
      config.destination = 'database';
      return ask(question);
    });
    const result = await runLicenseReview({ artifact: original, config, io });
    expect(result.config.destination).toBe('json');
    expect(result.artifact.catalog[0].name).toBe('Bible 1');
    expect(() => {
      result.config.destination = 'database';
    }).toThrow();
    expect(() => {
      result.reports.model.inventory[0].bibles.pop();
    }).toThrow();
  });
  it('aborts on report regeneration failure before offering write confirmation', async () => {
    const io = scriptedLicenseReviewIo([]);
    await expect(
      runLicenseReview({
        artifact: makeLicenseArtifact(),
        config: makeLicenseReviewConfig(),
        io,
        regenerateReports: vi.fn().mockRejectedValue(new Error('Report failed')),
      })
    ).rejects.toThrow('Report failed');
    expect(io.ask).not.toHaveBeenCalled();
  });
});

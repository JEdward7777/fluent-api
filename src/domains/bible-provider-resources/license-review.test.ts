import { describe, expect, it, vi } from 'vitest';

import { attestLicenseArtifact } from './license-artifact';
import { makeLicenseArtifact, REVIEWER } from './license-artifact.test-fixtures';
import { runLicenseReview } from './license-review';
import { makeLicenseReviewConfig, scriptedLicenseReviewIo } from './license-review.test-fixtures';

describe('interactive review and Save intent', () => {
  it('saves validated mixed-state decisions after one final confirmation without batch signoff', async () => {
    const original = makeLicenseArtifact();
    const before = structuredClone(original);
    const io = scriptedLicenseReviewIo(['W', 'y']);
    const regenerateReports = vi.fn(async () => {});
    const result = await runLicenseReview({
      artifact: original,
      config: makeLicenseReviewConfig({ formats: 'markdown,html' }),
      io,
      regenerateReports,
    });
    expect(result).toMatchObject({
      action: 'write',
      writeIntent: true,
      attestationDeclined: false,
    });
    expect(result.artifact.attestation).toBeUndefined();
    expect(regenerateReports).toHaveBeenCalledOnce();
    expect(io.ask).toHaveBeenCalledTimes(2);
    expect(io.ask.mock.calls.at(-1)![0]).toContain(result.artifact.reviewContentHash);
    expect(original).toEqual(before);
    expect(Object.isFrozen(result.artifact.classifications[0])).toBe(true);
  });

  it('preserves an existing whole-file assertion without asking for another', async () => {
    const io = scriptedLicenseReviewIo(['W', 'y']);
    const result = await runLicenseReview({
      artifact: attestLicenseArtifact(makeLicenseArtifact(), REVIEWER),
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result.writeIntent).toBe(true);
    expect(result.artifact.attestation?.reviewedBy).toBe(REVIEWER.reviewedBy);
    expect(io.ask).toHaveBeenCalledTimes(2);
  });

  it('offers a separate optional assertion without promoting any row', async () => {
    const original = makeLicenseArtifact();
    const io = scriptedLicenseReviewIo(['A', REVIEWER.reviewedBy, REVIEWER.reviewReason, 'W', 'y']);
    const result = await runLicenseReview({
      artifact: original,
      config: makeLicenseReviewConfig(),
      io,
      now: () => REVIEWER.reviewedAt,
    });
    expect(result.artifact.attestation?.reviewedBy).toBe(REVIEWER.reviewedBy);
    expect(result.artifact.classifications).toEqual(original.classifications);
    expect(result.writeIntent).toBe(true);
  });

  it.each(['json', 'database', 'both'] as const)(
    'permits an unattested mixed-state JSON draft to %s',
    async (destination) => {
      const io = scriptedLicenseReviewIo(['W', 'y']);
      const result = await runLicenseReview({
        artifact: makeLicenseArtifact(),
        config: makeLicenseReviewConfig({
          destination,
          ...(destination !== 'json'
            ? { database: { label: 'Fixture database', resources: [] } }
            : {}),
        }),
        io,
      });
      expect(result.writeIntent).toBe(true);
      expect(result.artifact.attestation).toBeUndefined();
      expect(io.ask).toHaveBeenCalledTimes(2);
    }
  );

  it('defaults final confirmation to no', async () => {
    const io = scriptedLicenseReviewIo(['W', '', 'Q']);
    const result = await runLicenseReview({
      artifact: makeLicenseArtifact(),
      config: makeLicenseReviewConfig(),
      io,
    });
    expect(result).toMatchObject({ action: 'quit', writeIntent: false });
    expect(io.write.mock.calls.some(([message]) => message.includes('Write canceled'))).toBe(true);
  });

  it.each([{ interactive: false }, { yes: true }])(
    'rejects noninteractive review: %j',
    async (override) => {
      const io = scriptedLicenseReviewIo([]);
      await expect(
        runLicenseReview({ artifact: 'not parsed', config: makeLicenseReviewConfig(override), io })
      ).rejects.toThrow('Interactive review');
      expect(io.ask).not.toHaveBeenCalled();
    }
  );

  it('requires database context for a selected database source', async () => {
    const io = scriptedLicenseReviewIo([]);
    await expect(
      runLicenseReview({
        artifact: makeLicenseArtifact(),
        config: makeLicenseReviewConfig({ source: 'database' }),
        io,
      })
    ).rejects.toThrow('actual impact context');
  });

  it('keeps the frozen review independent of caller mutations', async () => {
    const original = makeLicenseArtifact();
    const config = makeLicenseReviewConfig();
    const io = scriptedLicenseReviewIo(['W', 'y']);
    const ask = io.ask.getMockImplementation()!;
    io.ask.mockImplementation(async (question) => {
      original.catalog[0].name = 'Externally changed';
      config.destination = 'database';
      return ask(question);
    });
    const result = await runLicenseReview({ artifact: original, config, io });
    expect(result.config.destination).toBe('json');
    expect(result.artifact.catalog[0].name).toBe('Bible 1');
  });

  it('fails before a write prompt if report generation fails', async () => {
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

import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import type { LicensePracticeCapability } from './license-practice';

import { makeCommandFixture } from './license-command.test-fixtures';
import { createLicensePractice } from './license-practice';
import { LicenseWorkflow } from './license-workflow';
import { licenseFileIo } from './license-write';

describe('explicit offline license practice capability', () => {
  it('copies only at Inspect, removes imported attestation and saves incomplete output in new scratch', async () => {
    const fixture = await makeCommandFixture();
    let scratch: string | undefined;
    try {
      const practice = await createLicensePractice(fixture.input);
      scratch = practice.scratch;
      expect(practice.originalHash).toBe(
        createHash('sha256').update(fixture.sourceBytes).digest('hex')
      );
      expect((await stat(`${scratch}/original.json`)).mode & 0o777).toBe(0o400);
      expect(await readFile(`${scratch}/original.json`, 'utf8')).toBe(fixture.sourceBytes);
      const forged = new LicenseWorkflow(practice.options, {
        apiKey: '',
        practice: {
          input: fixture.input,
          output: fixture.output,
          cacheDir: fixture.dir,
          reportDir: fixture.dir,
        },
      });
      await expect(forged.inspect(1)).rejects.toThrow('Unissued practice capability');
      const capability = (
        practice.workflow as unknown as { dependencies: { practice: LicensePracticeCapability } }
      ).dependencies.practice;
      const injectedFs = new LicenseWorkflow(practice.options, {
        apiKey: '',
        practice: capability,
        fs: {
          ...licenseFileIo,
          write: async () => {
            throw new Error('would redirect outside scratch');
          },
        },
      });
      await expect(injectedFs.inspect(1)).rejects.toThrow('file override capabilities');
      const injectedKey = new LicenseWorkflow(practice.options, {
        apiKey: 'forbidden',
        practice: capability,
      });
      await expect(injectedKey.inspect(1)).rejects.toThrow(
        'model, database or file override capabilities'
      );
      const staleBypass = new LicenseWorkflow(practice.options, {
        apiKey: '',
        practice: capability,
        legacySkipFreshness: true,
      });
      await expect(staleBypass.inspect(1)).rejects.toThrow('file override capabilities');
      const inspection = await practice.workflow.inspect(1);
      expect(inspection.preflight.expectedUncachedRequests).toBe(0);
      const analysis = await practice.workflow.startAnalysis(1);
      expect(analysis.artifact.attestation).toBeUndefined();
      expect(analysis.artifact.reviewState).toBe('incomplete');
      const preview = await practice.workflow.preview(1, analysis.contentRevision);
      expect(preview.plan.targets).toHaveLength(1);
      expect(preview.plan.targets[0].path).toBe(practice.options.output);
      expect(() =>
        practice.workflow.exportReport({
          operationId: 'outside-report',
          configurationRevision: 1,
          contentRevision: analysis.contentRevision,
          format: 'html',
          path: fixture.output,
          expectedPreviousBytes: null,
          agreeToOverwrite: true,
        })
      ).toThrow('Practice cannot export reports');
      await expect(readFile(fixture.output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(() =>
        practice.workflow.attest(
          { reviewedBy: 'Forged', reviewReason: 'Forged', reviewedAt: new Date().toISOString() },
          1,
          analysis.contentRevision,
          preview.reports.reviewContentHash
        )
      ).toThrow('Practice cannot attest');
      await practice.workflow.save({
        operationId: 'practice-save',
        configurationRevision: 1,
        contentRevision: analysis.contentRevision,
        agreeToReplace: false,
      });
      const written = JSON.parse(await readFile(practice.options.output, 'utf8'));
      expect(written.reviewState).toBe('incomplete');
      expect(written.attestation).toBeUndefined();
      expect(await readFile(fixture.input, 'utf8')).toBe(fixture.sourceBytes);
      expect(await readFile(`${scratch}/original.json`, 'utf8')).toBe(fixture.sourceBytes);
      await practice.workflow.close();
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });
});

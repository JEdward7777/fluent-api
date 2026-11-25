import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

import { recordHumanLicenseDecision, serializeLicenseArtifact } from '../license-artifact';
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseKeyDigest } from './license-eligibility';
import { LicenseWorkflow } from './license-workflow';
import { parseLicenseArtifactBytes } from './license-workflow-freshness';

it.each([
  { paid: false, persisted: false },
  { paid: false, persisted: true },
  { paid: true, persisted: false },
  { paid: true, persisted: true },
])(
  'archives a displaced pending decision (paid $paid, saved baseline $persisted)',
  async ({ paid, persisted }) => {
    const f = await makeCommandFixture(false);
    const workflow = new LicenseWorkflow(f.options, {
      ...f.dependencies,
      destinationDatabase: f.dependencies.database,
    });
    try {
      const row = f.artifact.classifications[0];
      const id = licenseKeyDigest(row.normalizedText);
      const reviewedAt = '2026-01-01T00:00:00.000Z';
      if (persisted)
        await writeFile(
          f.input,
          serializeLicenseArtifact(
            recordHumanLicenseDecision(
              f.artifact,
              row.normalizedText,
              'unknown',
              { reviewComment: 'Saved exception' },
              'Historical reviewer',
              reviewedAt
            )
          ).bytes
        );
      await workflow.inspect(1);
      const envelope = () => ({
        id,
        mutationId: crypto.randomUUID(),
        epoch: workflow.reviewDrafts.epoch,
        contentRevision: workflow.status.contentRevision,
      });
      const patch = (reviewComment: string) =>
        workflow.mutateDraft(
          { ...envelope(), kind: 'patch', status: 'allowed', reviewComment, touched: true },
          true
        );
      expect(patch('Pending exception').conflict).toBe(false);
      const selection = { kind: paid ? ('model' as const) : ('rule' as const), id };
      const estimate = await workflow.prepareFree(workflow.status.contentRevision, selection);
      if (paid)
        await workflow.runPaid(
          {
            fingerprint: estimate.fingerprint,
            maximumRequests: estimate.expectedUncachedRequests,
            replacementConfirmations: [estimate.outstanding[0].replacementConfirmation!],
          },
          { attempts: 0, completedRows: 0 }
        );
      else await workflow.prepareFree(workflow.status.contentRevision, estimate.replacements[0]);
      const result = workflow.analyzed!.artifact;
      const accepted = result.classifications[0];
      expect(accepted.reviewHistory?.at(-1)).toEqual({
        reviewState: 'pending_human_review',
        status: 'allowed',
        source: 'manual',
        reviewComment: 'Pending exception',
        reviewedBy: null,
        decisionAt: null,
        humanReviewedAt: null,
        rationale: null,
        rowNote: null,
      });
      if (persisted)
        expect(accepted.reviewHistory?.at(-2)).toMatchObject({
          reviewState: 'human_reviewed',
          status: 'unknown',
          reviewComment: 'Saved exception',
          reviewedBy: 'Historical reviewer',
          decisionAt: reviewedAt,
          humanReviewedAt: reviewedAt,
        });
      const bytes = serializeLicenseArtifact(result).bytes;
      expect(parseLicenseArtifactBytes(bytes).classifications[0]).toEqual(accepted);
      const corrupted = JSON.parse(bytes);
      corrupted.classifications[0].reviewHistory.at(-1).reviewedBy = 'False attribution';
      expect(() => parseLicenseArtifactBytes(JSON.stringify(corrupted))).toThrow();
      expect(patch('Subsequent draft').conflict).toBe(false);
      expect(workflow.mutateDraft({ ...envelope(), kind: 'revert' }, true).values).toMatchObject({
        pending: false,
        status: accepted.status,
        reviewState: accepted.reviewState,
        reviewComment: null,
      });
      expect(workflow.analyzed!.artifact.classifications[0]).toEqual(accepted);
      expect(f.dependencies.transport).toHaveBeenCalledTimes(paid ? f.options.sampleCount : 0);
    } finally {
      await workflow.close();
      await f.cleanup();
    }
  }
);

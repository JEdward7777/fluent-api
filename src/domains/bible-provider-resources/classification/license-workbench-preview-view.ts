import { createHash } from 'node:crypto';

import type { LicenseCommandOptions } from './license-command-options';
import type { StoredLicenseClassification } from './license-database.types';
import type { LicenseWorkflow } from './license-workflow';

import { checkLicenseArtifactReview } from '../license-artifact';
import { planLicenseMaintenanceChanges } from './license-database-projection';

/** Publish only reviewable preview facts, never target prior bytes or credentials. */
export function licenseWorkbenchPreviewView(input: {
  workflow?: LicenseWorkflow;
  options: LicenseCommandOptions;
  configurationRevision: number;
  policyBaseline?: StoredLicenseClassification[];
  practiceMode: boolean;
}) {
  const { workflow, options, configurationRevision, policyBaseline, practiceMode } = input;
  const preview = workflow?.previewed;
  if (!preview) return null;
  const impact = preview.reports.model.impact;
  const review = workflow?.analyzed ? checkLicenseArtifactReview(workflow.analyzed.artifact) : null;
  const maintenance =
    !preview.plan.replace && workflow?.analyzed && policyBaseline
      ? planLicenseMaintenanceChanges(workflow.analyzed.artifact, policyBaseline)
      : null;
  return {
    configurationRevision,
    contentRevision: preview.contentRevision,
    reviewContentHash: preview.plan.reviewContentHash,
    wholeFileHash: preview.plan.wholeFileHash,
    targets: preview.plan.targets.map((target) => ({
      path: target.path,
      role: target.role,
      existed: target.previous !== null,
      previousHash:
        target.previous === null
          ? null
          : createHash('sha256').update(target.previous).digest('hex'),
    })),
    output: preview.plan.targets[0]?.path,
    replace: preview.plan.replace,
    requiresForceAgreement: preview.plan.requiresForceAgreement,
    policy:
      options.destination === 'json'
        ? null
        : preview.plan.replace
          ? {
              inserts: impact?.classificationChanges?.insertedKeys ?? [],
              updates: impact?.classificationChanges?.changedKeys ?? [],
              deletes: impact?.classificationChanges?.deletedKeys ?? [],
            }
          : maintenance
            ? {
                inserts: maintenance.insertedKeys,
                updates: maintenance.changedKeys,
                deletes: maintenance.deletedKeys,
              }
            : null,
    forecast: impact
      ? {
          context: impact.context,
          changedStatuses: impact.changes.length,
          gains: impact.ttsGains,
          losses: impact.ttsLosses,
          missingClassifications: impact.missingClassifications.length,
          preservationWarning: impact.preservationWarning,
        }
      : null,
    review: review
      ? { status: review.status, reasons: 'reasons' in review ? review.reasons : [] }
      : null,
    incomplete: practiceMode || review?.status !== 'ready',
  };
}

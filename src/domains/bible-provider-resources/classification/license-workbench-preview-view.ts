import { createHash } from 'node:crypto';

import type { LicenseCommandOptions } from './license-command-options';
import type { StoredLicenseClassification } from './license-database.types';
import type { LicenseWorkflow } from './license-workflow';

import { checkLicenseArtifactReview } from '../license-artifact';

/** Publish only reviewable preview facts, never target prior bytes or credentials. */
export function licenseWorkbenchPreviewView(input: {
  workflow?: LicenseWorkflow;
  loadedDatabaseTarget: string | null;
  destinationDatabaseTarget: string;
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
  void policyBaseline;
  return {
    configurationRevision,
    sourceLabel: options.source === 'database' ? input.loadedDatabaseTarget : options.input,
    destinationDatabaseLabel:
      options.destination === 'json' ? null : input.destinationDatabaseTarget,
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
    conflicts: preview.plan.conflicts,
    json: preview.plan.jsonArtifact
      ? { operation: options.source === 'json' ? 'overwrite' : 'sync', ...preview.plan.jsonChanges }
      : null,
    database: preview.plan.databaseArtifact
      ? {
          operation: preview.plan.replace ? 'overwrite' : 'sync',
          ...preview.plan.databaseChanges,
        }
      : null,
    policy:
      options.destination === 'json'
        ? null
        : {
            inserts: preview.plan.databaseChanges.inserted,
            updates: preview.plan.databaseChanges.updated,
            deletes: [],
          },
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

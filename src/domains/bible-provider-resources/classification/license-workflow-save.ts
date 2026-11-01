import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type {
  LicenseAnalysis,
  LicenseInspection,
  LicensePreview,
  LicenseSaveRequest,
  LicenseSaveResult,
} from './license-workflow.types';
import type { LicenseFileIo } from './license-write';

import { freezeReviewValue } from '../license-review-revision';
import { LicenseInspectionStaleError, requireFreshLicenseSources } from './license-freshness';
import { licenseFileIo, writeLicenseDestinations } from './license-write';

export class LicenseSavePreflightError extends Error {
  constructor(cause: unknown) {
    super('Could not recheck inspected inputs before Save; retry inspection when available', {
      cause,
    });
    this.name = 'LicenseSavePreflightError';
  }
}

export function licenseSaveFingerprint(request: LicenseSaveRequest) {
  return JSON.stringify([
    request.operationId,
    request.configurationRevision,
    request.contentRevision,
    request.agreeToReplace,
  ]);
}

/** Strict browser Save: freshness opt-outs belong only to the legacy CLI path. */
export async function writePreviewedLicenseSave(input: {
  request: LicenseSaveRequest;
  preview: LicensePreview;
  inspection: LicenseInspection;
  analysis: LicenseAnalysis;
  options: LicenseCommandOptions;
  database?: LicenseDatabaseAdapter;
  fs?: LicenseFileIo;
}): Promise<LicenseSaveResult> {
  const { request, preview, inspection, analysis, options, database, fs } = input;
  try {
    await requireFreshLicenseSources(inspection, options, fs ?? licenseFileIo, database);
  } catch (error) {
    if (error instanceof LicenseInspectionStaleError) throw error;
    throw new LicenseSavePreflightError(error);
  }
  await writeLicenseDestinations({
    artifact: analysis.artifact,
    files: preview.plan.targets.map(({ path, previous }) => ({ path, previous })),
    database: options.destination !== 'json' ? database : undefined,
    replace: preview.plan.replace,
    force: preview.plan.requiresForceAgreement && request.agreeToReplace,
    fs,
    expectedFiles: preview.plan.expectedFiles,
    expectedPolicy:
      options.destination !== 'json' ? inspection.database?.classifications : undefined,
  });
  return freezeReviewValue({
    configurationRevision: request.configurationRevision,
    contentRevision: request.contentRevision,
    operationId: request.operationId,
    wholeFileHash: preview.plan.wholeFileHash,
    targets: preview.plan.targets,
  });
}

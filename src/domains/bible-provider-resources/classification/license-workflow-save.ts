import { resolve } from 'node:path';

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
import { LicensePolicyDriftError } from './license-database.types';
import { matchesLicenseFile } from './license-file-identity';
import {
  LicenseDestinationRecheckError,
  LicenseInspectionStaleError,
  requireFreshLicenseDestination,
  requireFreshLicenseSources,
} from './license-freshness';
import { LicenseFileDriftError, licenseFileIo, writeLicenseDestinations } from './license-write';

export async function requirePreviewFileIdentities(plan: LicensePreview['plan']) {
  for (const identity of [plan.sourceIdentity, plan.targetIdentity]) {
    if (identity && !(await matchesLicenseFile(identity)))
      throw new LicenseFileDriftError(identity.path);
  }
}

export class LicenseSavePreflightError extends Error {
  constructor(cause: unknown) {
    super('Could not recheck inspected inputs before Save; retry inspection when available', {
      cause,
    });
    this.name = 'LicenseSavePreflightError';
  }
}

export function destinationSaveFailure(error: unknown, options: LicenseCommandOptions) {
  return (
    error instanceof LicenseDestinationRecheckError ||
    error instanceof LicensePolicyDriftError ||
    (error instanceof LicenseFileDriftError &&
      (options.source !== 'json' || resolve(error.path) !== resolve(options.input)))
  );
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
  loadedSource?: { inspection: LicenseInspection; database?: LicenseDatabaseAdapter };
  fs?: LicenseFileIo;
}): Promise<LicenseSaveResult> {
  const { request, preview, inspection, analysis, options, database, fs } = input;
  if (preview.plan.conflicts.length)
    throw new Error(`Save conflicts: ${preview.plan.conflicts.join('; ')}`);
  try {
    if (input.loadedSource)
      await requireFreshLicenseSources(
        input.loadedSource.inspection,
        options,
        fs ?? licenseFileIo,
        input.loadedSource.database
      );
    if (!input.loadedSource)
      await requireFreshLicenseSources(inspection, options, fs ?? licenseFileIo, database);
  } catch (error) {
    if (error instanceof LicenseInspectionStaleError) throw error;
    throw new LicenseSavePreflightError(error);
  }
  if (input.loadedSource)
    await requireFreshLicenseDestination(
      inspection,
      options,
      fs ?? licenseFileIo,
      options.destination === 'json' ? undefined : database
    );
  await writeLicenseDestinations({
    artifact: preview.plan.databaseArtifact ?? analysis.artifact,
    fileArtifact: preview.plan.jsonArtifact,
    files: preview.plan.targets.map(({ path, previous }) => ({ path, previous })),
    database: options.destination !== 'json' ? database : undefined,
    replace: preview.plan.replace,
    force: false,
    databaseIdentity:
      preview.plan.targetMarker ||
      preview.plan.databaseProof ||
      inspection.database?.relation !== undefined
        ? {
            marker: preview.plan.targetMarker,
            expected: preview.plan.databaseProof,
            target: inspection.database?.relation,
            challenge: (input.loadedSource?.database ?? database)?.challenge?.(
              (input.loadedSource?.inspection ?? inspection).database?.sourceMarker
            ),
          }
        : undefined,
    checkFileIdentities: () => requirePreviewFileIdentities(preview.plan),
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

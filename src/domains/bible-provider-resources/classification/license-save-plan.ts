import { resolve } from 'node:path';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseReportBundle } from '../license-reports';
import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseSnapshot } from './license-database.types';

import { checkLicenseArtifactReview, serializeLicenseArtifact } from '../license-artifact';
import { renderLicenseReports } from '../license-reports';

export interface LicenseSaveTarget {
  path: string;
  previous: string | null;
  role: 'output' | 'signed-source';
}

export interface LicenseSavePlan {
  targets: LicenseSaveTarget[];
  expectedFiles: { path: string; bytes: string | null }[];
  replace: boolean;
  requiresForceAgreement: boolean;
  wholeFileHash: string;
  reviewContentHash: string;
  reports: LicenseReportBundle;
}

/** Build the exact publication set and its original bytes from the inspected snapshot. */
export function buildLicenseSavePlan(input: {
  options: LicenseCommandOptions;
  artifact: LicenseArtifact;
  originalSourceArtifact?: LicenseArtifact;
  inputBytes: string | null;
  outputBytes: string | null;
  database?: LicenseDatabaseSnapshot;
}): LicenseSavePlan {
  const { options, artifact, originalSourceArtifact, inputBytes, outputBytes, database } = input;
  const replace = options.source === 'json' && options.destination !== 'json';
  const reports = renderLicenseReports(artifact, {
    formats: options.reportFormats,
    outputDir: options.reportDir,
    interactive: false,
    yes: false,
    database: database
      ? {
          ...database.context,
          ...(replace
            ? { classificationTable: { existing: database.classifications, replace: true } }
            : {}),
        }
      : undefined,
    preserveExistingNonUnknowns: options.preserveExistingNonUnknowns,
  });
  const targets: LicenseSaveTarget[] = [];
  if (options.destination !== 'database')
    targets.push({ path: resolve(options.output), previous: outputBytes, role: 'output' });
  const signedSource =
    replace &&
    originalSourceArtifact !== undefined &&
    checkLicenseArtifactReview(artifact).status === 'ready' &&
    (originalSourceArtifact.reviewContentHash !== artifact.reviewContentHash ||
      originalSourceArtifact.reviewState !== artifact.reviewState ||
      JSON.stringify(originalSourceArtifact.attestation) !== JSON.stringify(artifact.attestation));
  if (signedSource && !targets.some((target) => target.path === resolve(options.input)))
    targets.push({ path: resolve(options.input), previous: inputBytes, role: 'signed-source' });
  const expectedFiles = [
    ...(options.source === 'json' ? [{ path: resolve(options.input), bytes: inputBytes }] : []),
    ...(resolve(options.output) !== resolve(options.input) || options.source !== 'json'
      ? [{ path: resolve(options.output), bytes: outputBytes }]
      : []),
  ];
  const { wholeFileHash } = serializeLicenseArtifact(artifact);
  return {
    targets,
    expectedFiles,
    replace,
    requiresForceAgreement: replace && !!database?.classifications.length,
    wholeFileHash,
    reviewContentHash: artifact.reviewContentHash,
    reports,
  };
}

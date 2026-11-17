import { resolve } from 'node:path';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseReportBundle } from '../license-reports';
import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseSnapshot } from './license-database.types';
import type { DestinationDecisionPlan } from './license-save-destinations';

import { serializeLicenseArtifact } from '../license-artifact';
import { renderLicenseReports } from '../license-reports';
import { planLicenseSaveDestinations } from './license-save-destinations';

export interface LicenseSaveTarget {
  path: string;
  previous: string | null;
  role: 'output';
}

export interface LicenseSavePlan extends DestinationDecisionPlan {
  targets: LicenseSaveTarget[];
  expectedFiles: { path: string; bytes: string | null }[];
  replace: boolean;
  requiresForceAgreement: boolean;
  wholeFileHash: string;
  reviewContentHash: string;
  reports: LicenseReportBundle;
}

/** Preview exact independent destination outputs from the inspected snapshots. */
export function buildLicenseSavePlan(input: {
  options: LicenseCommandOptions;
  artifact: LicenseArtifact;
  originalSourceArtifact?: LicenseArtifact;
  inputBytes: string | null;
  outputBytes: string | null;
  database?: LicenseDatabaseSnapshot;
}): LicenseSavePlan {
  const { options, artifact, inputBytes, outputBytes, database } = input;
  if (!options.source || !options.destination) throw new Error('Select source and destination');
  const destinations = planLicenseSaveDestinations({
    source: options.source,
    destination: options.destination,
    artifact,
    outputBytes,
    databaseRows: database?.classifications,
  });
  const reportingArtifact = destinations.databaseForecast ?? destinations.jsonArtifact ?? artifact;
  const reports = renderLicenseReports(reportingArtifact, {
    formats: options.reportFormats,
    outputDir: options.reportDir,
    interactive: false,
    yes: false,
    database: database
      ? {
          ...database.context,
          ...(options.destination !== 'json'
            ? { classificationTable: { existing: database.classifications, replace: true } }
            : {}),
        }
      : undefined,
    preserveExistingNonUnknowns: options.preserveExistingNonUnknowns,
  });
  const targets: LicenseSaveTarget[] =
    options.destination === 'database'
      ? []
      : [{ path: resolve(options.output), previous: outputBytes, role: 'output' }];
  const expectedFiles = [
    ...(options.source === 'json' ? [{ path: resolve(options.input), bytes: inputBytes }] : []),
    ...(resolve(options.output) !== resolve(options.input) || options.source !== 'json'
      ? [{ path: resolve(options.output), bytes: outputBytes }]
      : []),
  ];
  const output = serializeLicenseArtifact(destinations.jsonArtifact ?? artifact);
  return {
    ...destinations,
    targets,
    expectedFiles,
    replace: options.source === 'database' && options.destination !== 'json',
    requiresForceAgreement: false,
    wholeFileHash: output.wholeFileHash,
    reviewContentHash: (destinations.jsonArtifact ?? artifact).reviewContentHash,
    reports,
  };
}

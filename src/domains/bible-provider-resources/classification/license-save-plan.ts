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
  sourceIdentity?: import('./license-file-identity').LicenseFileIdentity;
  targetIdentity?: import('./license-file-identity').LicenseFileIdentity;
  targetMarker?: string;
  databaseProof?: import('./license-database-identity').DatabaseProof;
  overwriteJson?: boolean;
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
  overwriteJson?: boolean;
  overwriteDatabase?: boolean;
  inspectOutput?: boolean;
}): LicenseSavePlan {
  const { options, artifact, inputBytes, outputBytes, database } = input;
  if (!options.source || !options.destination) throw new Error('Select source and destination');
  const overwriteJson =
    input.overwriteJson ??
    (options.source === 'json' && resolve(options.input) === resolve(options.output));
  const destinations = planLicenseSaveDestinations({
    destination: options.destination,
    artifact,
    outputBytes,
    databaseRows: database?.classifications,
    overwriteJson,
    overwriteDatabase: input.overwriteDatabase ?? false,
  });
  const reports = renderLicenseReports(artifact, {
    impactArtifact: destinations.databaseForecast ?? destinations.jsonArtifact,
    formats: options.reportFormats,
    outputDir: options.reportDir,
    interactive: false,
    yes: false,
    database: database
      ? {
          ...database.context,
          ...(options.destination !== 'json'
            ? {
                classificationTable: {
                  changes: {
                    deletedKeys: [],
                    insertedKeys: destinations.databaseChanges.inserted,
                    changedKeys: destinations.databaseChanges.updated,
                  },
                },
              }
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
    ...(input.inspectOutput !== false &&
    (resolve(options.output) !== resolve(options.input) || options.source !== 'json')
      ? [{ path: resolve(options.output), bytes: outputBytes }]
      : []),
  ];
  const output = serializeLicenseArtifact(destinations.jsonArtifact ?? artifact);
  return {
    ...destinations,
    overwriteJson,
    targets,
    expectedFiles,
    replace: input.overwriteDatabase === true && options.destination !== 'json',
    requiresForceAgreement: false,
    wholeFileHash: output.wholeFileHash,
    reviewContentHash: artifact.reviewContentHash,
    reports,
  };
}

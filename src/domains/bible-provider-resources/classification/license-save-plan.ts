import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';

import { hashCanonicalJson } from '@/lib/llm/canonical-json';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseReportBundle } from '../license-reports';
import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseSnapshot } from './license-database.types';
import type { DestinationDecisionPlan } from './license-save-destinations';

import { serializeLicenseArtifact } from '../license-artifact';
import { renderLicenseReports } from '../license-reports';
import { comparableCatalog } from './license-freshness';
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
  artifactBytes: number;
  impactContextHash: string | null;
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
  const output = serializeLicenseArtifact(destinations.jsonArtifact ?? artifact);
  const reports = renderLicenseReports(artifact, {
    targets: {
      json: destinations.jsonArtifact
        ? {
            path: resolve(options.output),
            reviewContentHash: destinations.jsonArtifact.reviewContentHash,
            wholeFileHash: output.wholeFileHash,
            assertion: destinations.jsonArtifact.attestation,
          }
        : undefined,
      database: destinations.databaseForecast
        ? {
            reviewContentHash: destinations.databaseForecast.reviewContentHash,
            label: database?.context.label,
          }
        : undefined,
    },
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
  return {
    ...destinations,
    overwriteJson,
    targets,
    expectedFiles,
    replace: input.overwriteDatabase === true && options.destination !== 'json',
    requiresForceAgreement: false,
    wholeFileHash: output.wholeFileHash,
    artifactBytes: Buffer.byteLength(output.bytes),
    impactContextHash: database
      ? hashCanonicalJson({
          relation: database.relation ? { ...database.relation } : null,
          catalog: comparableCatalog(database.context),
        })
      : null,
    reviewContentHash: artifact.reviewContentHash,
    reports,
  };
}

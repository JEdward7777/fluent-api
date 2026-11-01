import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type { LicenseInspection, LicenseWorkflowDependencies } from './license-workflow.types';

import { createLicenseClassifier } from '../license-classifier';
import { freezeLicenseRevision } from '../license-review-revision';
import { analyzeDatabaseLicenses } from './license-analysis';
import {
  parseLicenseArtifactBytes,
  requireFreshLicenseInspection,
} from './license-workflow-freshness';
import { licenseFileIo } from './license-write';

export async function analyzeInspectedLicenses(input: {
  inspection: LicenseInspection;
  options: LicenseCommandOptions;
  dependencies: LicenseWorkflowDependencies;
  database?: LicenseDatabaseAdapter;
  shouldStop: () => boolean;
}) {
  const { inspection, options, dependencies, database } = input;
  if (!dependencies.legacySkipFreshness)
    await requireFreshLicenseInspection(
      inspection,
      options,
      dependencies.fs ?? licenseFileIo,
      database
    );
  const base =
    options.source === 'database' && inspection.outputBytes !== null
      ? parseLicenseArtifactBytes(inspection.outputBytes)
      : undefined;
  const artifact =
    options.source === 'json'
      ? parseLicenseArtifactBytes(inspection.inputBytes!)
      : await analyzeDatabaseLicenses({
          catalog: inspection.database!.context.resources.map(
            ({ ttsLicenseStatus: _status, ...row }) => row
          ),
          classifications: inspection.database!.classifications,
          base,
          classify: createLicenseClassifier({
            apiKey: dependencies.apiKey,
            model: options.model,
            sampleCount: options.sampleCount,
            cacheDir: options.cacheDir,
            noCache: options.noCache,
            transport: dependencies.transport,
          }),
          model: options.model,
          sampleCount: options.sampleCount,
          shouldStop: input.shouldStop,
        });
  return freezeLicenseRevision(artifact);
}

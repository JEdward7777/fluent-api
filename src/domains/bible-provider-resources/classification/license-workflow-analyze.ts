import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type { LicenseInspection, LicenseWorkflowDependencies } from './license-workflow.types';

import { createLicenseClassifier } from '../license-classifier';
import { freezeLicenseRevision } from '../license-review-revision';
import { analyzeDatabaseLicenses, analyzeJsonLicenses } from './license-analysis';
import { inspectLicensePreflight } from './license-preflight';
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
  const jsonSource =
    options.source === 'json' ? parseLicenseArtifactBytes(inspection.inputBytes!) : undefined;
  const currentPreflight = await inspectLicensePreflight({
    database: options.source === 'database' ? inspection.database : undefined,
    jsonClassifications: jsonSource?.classifications,
    jsonNotices: jsonSource?.catalog.flatMap((row) =>
      row.rawNotice?.trim() ? [row.rawNotice] : []
    ),
    rerunRule: options.rerunRule,
    rerunModel: options.rerunModel,
    model: options.model,
    sampleCount: options.sampleCount,
    cacheDir: options.cacheDir,
    noCache: options.noCache,
  });
  if (JSON.stringify(currentPreflight) !== JSON.stringify(inspection.preflight))
    throw new Error('Assessment preflight changed; Inspect again before Analyze');
  if (currentPreflight.expectedUncachedRequests > 0 && !dependencies.apiKey.trim())
    throw new Error('A nonempty GOOGLE_AI_API_KEY is required before a model request');
  const classifier = () =>
    createLicenseClassifier({
      apiKey: dependencies.apiKey,
      model: options.model,
      sampleCount: options.sampleCount,
      cacheDir: options.cacheDir,
      noCache: options.noCache,
      transport: dependencies.transport,
    });
  const artifact =
    options.source === 'json'
      ? inspection.preflight.rows.every(
          (row) => row.action === 'retain' || (row.action === 'rule' && !row.ruleMatches)
        )
        ? jsonSource!
        : await analyzeJsonLicenses({
            artifact: jsonSource!,
            eligibility: inspection.preflight.rows,
            classify: classifier(),
            model: options.model,
            sampleCount: options.sampleCount,
            now: dependencies.now,
            shouldStop: input.shouldStop,
          })
      : await analyzeDatabaseLicenses({
          catalog: inspection.database!.context.resources.map(
            ({ ttsLicenseStatus: _status, ...row }) => row
          ),
          classifications: inspection.database!.classifications,
          base,
          classify: classifier(),
          model: options.model,
          sampleCount: options.sampleCount,
          eligibility: inspection.preflight.rows,
          now: dependencies.now,
          shouldStop: input.shouldStop,
        });
  return freezeLicenseRevision(artifact);
}

import { resolve } from 'node:path';

import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type { LicenseInspection, LicenseWorkflowDependencies } from './license-workflow.types';

import { freezeReviewValue } from '../license-review-revision';
import { isIssuedLicensePractice } from './license-practice';
import { inspectLicensePreflight } from './license-preflight';
import {
  LicenseBootstrapRequiredError,
  parseLicenseArtifactBytes,
} from './license-workflow-freshness';
import { licenseFileIo } from './license-write';

export async function inspectLicenseWorkflowInputs(input: {
  options: LicenseCommandOptions;
  dependencies: LicenseWorkflowDependencies;
  database?: LicenseDatabaseAdapter;
  onDatabase?: (database: LicenseDatabaseAdapter) => void;
  configurationRevision: number;
}): Promise<{ inspection: LicenseInspection; database?: LicenseDatabaseAdapter }> {
  const { options, dependencies } = input;
  if (!dependencies.apiKey.trim() && !dependencies.practice)
    throw new Error('A nonempty GEMINI_API_KEY is required before reading any source');
  if (dependencies.practice) {
    if (!isIssuedLicensePractice(dependencies.practice))
      throw new Error('Unissued practice capability');
    if (
      dependencies.apiKey ||
      dependencies.database ||
      dependencies.transport ||
      dependencies.fs ||
      dependencies.legacySkipFreshness ||
      input.database
    )
      throw new Error('Practice cannot hold model, database or file override capabilities');
    const practice = dependencies.practice;
    if (
      options.source !== 'json' ||
      options.destination !== 'json' ||
      options.input !== practice.input ||
      options.output !== practice.output ||
      options.cacheDir !== practice.cacheDir ||
      options.reportDir !== practice.reportDir ||
      options.force ||
      options.reviewer ||
      options.reviewReason
    )
      throw new Error('Practice is confined to its JSON scratch paths');
  }
  if (!options.source || !options.destination)
    throw new Error('Select both source and destination before analysis');
  if (!/^google:[^\s:]+$/.test(options.model))
    throw new Error(`Unsupported model reference: ${options.model}. Use google:<model-id>`);
  if (!Number.isInteger(options.sampleCount) || options.sampleCount < 2)
    throw new Error('Sample count must be an integer of at least two');
  const fs = dependencies.fs ?? licenseFileIo;
  let database = input.database;
  const needsDatabase = options.source === 'database' || options.destination !== 'json';
  if (needsDatabase && !database) {
    if (dependencies.database) database = await dependencies.database();
    else {
      const { createOwnedLicenseDatabaseAdapter } =
        await import('./license-classifications.service');
      const { default: environment } = await import('@/env');
      database = createOwnedLicenseDatabaseAdapter(environment.DATABASE_URL);
    }
  }
  if (database) input.onDatabase?.(database);
  const loaded = await database?.load();
  const snapshot = loaded ? freezeReviewValue(loaded) : undefined;
  if (options.destination !== 'json' && !snapshot?.tableExists)
    throw new Error(
      'The license_classifications table must exist before a database destination can be used'
    );
  if (
    options.source === 'database' &&
    options.destination !== 'json' &&
    !snapshot?.classifications.length
  )
    throw new LicenseBootstrapRequiredError();
  const inputBytes = options.source === 'json' ? await fs.read(options.input) : null;
  if (options.source === 'json' && inputBytes === null)
    throw new Error(`JSON source not found: ${options.input}`);
  const samePath = resolve(options.output) === resolve(options.input);
  const outputBytes =
    samePath && options.source === 'json' ? inputBytes : await fs.read(options.output);
  const preflight = await inspectLicensePreflight({
    database: options.source === 'database' ? snapshot : undefined,
    jsonClassificationKeys:
      options.source === 'json'
        ? parseLicenseArtifactBytes(inputBytes!).classifications.map((row) => row.normalizedText)
        : undefined,
    model: options.model,
    sampleCount: options.sampleCount,
    cacheDir: options.cacheDir,
    noCache: options.noCache,
  });
  return {
    database,
    inspection: freezeReviewValue({
      configurationRevision: input.configurationRevision,
      inspectedAt: dependencies.now?.() ?? new Date().toISOString(),
      inputBytes,
      outputBytes,
      preflight,
      ...(snapshot ? { database: snapshot } : {}),
    }),
  };
}

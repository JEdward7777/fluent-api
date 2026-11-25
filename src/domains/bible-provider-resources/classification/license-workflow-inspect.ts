import { resolve } from 'node:path';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type { LicenseInspection, LicenseWorkflowDependencies } from './license-workflow.types';

import {
  catalogLicenseNotices,
  indexLicenseNoticeExamples,
  savedLicenseNotices,
} from '../license-normalizer';
import { freezeReviewValue } from '../license-review-revision';
import { analyzeDatabaseLicenses } from './license-analysis';
import { licenseKeyDigest } from './license-eligibility';
import { inspectLicenseFile, matchesLicenseFile, reviewerJsonRoot } from './license-file-identity';
import { isIssuedLicensePractice } from './license-practice';
import { inspectLicensePreflight } from './license-preflight';
import { parseLicenseArtifactBytes } from './license-workflow-freshness';
import { licenseFileIo } from './license-write';

export class LicenseSourceReadError extends Error {}

async function readJsonSource(fs: typeof licenseFileIo, path: string) {
  try {
    return await fs.read(path);
  } catch {
    throw new LicenseSourceReadError(
      'Could not read the selected JSON source. Check its path and read permissions.'
    );
  }
}

function validateJsonSource(bytes: string) {
  try {
    return parseLicenseArtifactBytes(bytes);
  } catch {
    throw new LicenseSourceReadError(
      'Invalid JSON source. Check its classification format, evidence and review hash.'
    );
  }
}

export async function inspectLicenseWorkflowInputs(input: {
  options: LicenseCommandOptions;
  dependencies: LicenseWorkflowDependencies;
  database?: LicenseDatabaseAdapter;
  onDatabase?: (database: LicenseDatabaseAdapter) => void;
  configurationRevision: number;
}): Promise<{ inspection: LicenseInspection; database?: LicenseDatabaseAdapter }> {
  const { options, dependencies } = input;
  if (dependencies.practice) {
    if (!isIssuedLicensePractice(dependencies.practice))
      throw new Error('Unissued practice capability');
    if (
      dependencies.apiKey ||
      dependencies.database ||
      dependencies.destinationDatabase ||
      dependencies.transport ||
      dependencies.fs ||
      dependencies.legacySkipFreshness ||
      input.database
    )
      throw new Error('Practice cannot hold model, database or file override capabilities');
    requirePracticeOptions(options, dependencies.practice);
  }
  const sourceOnly = Boolean(dependencies.destinationDatabase);
  if (!options.source || (!sourceOnly && !options.destination))
    throw new Error('Select both source and destination before analysis');
  if (!/^google:[^\s:]+$/.test(options.model))
    throw new Error(`Unsupported model reference: ${options.model}. Use google:<model-id>`);
  if (!Number.isInteger(options.sampleCount) || options.sampleCount < 2)
    throw new Error('Sample count must be an integer of at least two');
  const fs = dependencies.fs ?? licenseFileIo;
  let database = input.database;
  const needsDatabase =
    options.source === 'database' || (!sourceOnly && options.destination !== 'json');
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
  const loaded =
    options.source === 'database' && database?.loadSource
      ? await database.loadSource()
      : await database?.load();
  const snapshot = loaded ? freezeReviewValue(loaded) : undefined;
  if (!sourceOnly && options.destination !== 'json' && !snapshot?.tableExists)
    throw new Error(
      'The license_classifications table must exist before a database destination can be used'
    );
  const inputIdentity =
    options.source === 'json' && fs === licenseFileIo
      ? await inspectLicenseFile(options.input, reviewerJsonRoot(dependencies.practice))
      : undefined;
  const inputBytes =
    options.source === 'json'
      ? await readJsonSource(fs, inputIdentity?.canonical ?? options.input)
      : null;
  if (options.source === 'json' && inputBytes === null)
    throw new Error(`JSON source not found: ${options.input}`);
  if (inputIdentity && !(await matchesLicenseFile(inputIdentity)))
    throw new Error('JSON source changed during load');
  const samePath = resolve(options.output) === resolve(options.input);
  const outputIdentity =
    !sourceOnly && fs === licenseFileIo
      ? await inspectLicenseFile(options.output, reviewerJsonRoot(dependencies.practice))
      : undefined;
  const outputBytes = sourceOnly
    ? null
    : samePath && options.source === 'json'
      ? inputBytes
      : await fs.read(outputIdentity?.canonical ?? options.output);
  const preflight = await inspectLoadedLicensePreflight(options, {
    sourceOnly: sourceOnly || undefined,
    inputBytes,
    outputBytes,
    database: snapshot,
  });
  return {
    database,
    inspection: freezeReviewValue({
      configurationRevision: input.configurationRevision,
      inspectedAt: dependencies.now?.() ?? new Date().toISOString(),
      ...(sourceOnly ? { sourceOnly: true as const } : {}),
      inputIdentity,
      outputIdentity,
      inputBytes,
      outputBytes,
      preflight,
      ...(snapshot ? { database: snapshot } : {}),
    }),
  };
}

export function inspectLoadedLicensePreflight(
  options: LicenseCommandOptions,
  {
    inputBytes,
    outputBytes,
    database: snapshot,
    sourceOnly,
  }: Pick<LicenseInspection, 'inputBytes' | 'outputBytes' | 'database' | 'sourceOnly'>
) {
  const jsonArtifact = options.source === 'json' ? validateJsonSource(inputBytes!) : undefined;
  return inspectLicensePreflight({
    reviewedRuleSelection: sourceOnly,
    database: options.source === 'database' ? snapshot : undefined,
    priorNotices:
      options.source === 'database' && outputBytes !== null
        ? savedLicenseNotices(parseLicenseArtifactBytes(outputBytes))
        : undefined,
    jsonClassifications: jsonArtifact?.classifications,
    jsonNotices: jsonArtifact?.catalog.flatMap((row) =>
      row.rawNotice?.trim() ? [row.rawNotice] : []
    ),
    rerunRule: options.rerunRule,
    rerunModel: options.rerunModel,
    model: options.model,
    sampleCount: options.sampleCount,
    cacheDir: options.cacheDir,
    noCache: options.noCache,
  });
}

/** Plan subsequent assessments from accepted row evidence and accepted catalog variants. */
export function inspectWorkingLicensePreflight(
  artifact: LicenseArtifact,
  options: LicenseCommandOptions
) {
  const catalog = catalogLicenseNotices(artifact.catalog);
  const examples = indexLicenseNoticeExamples(catalog);
  const available = new Set(
    artifact.classifications
      .filter((row) => row.exampleNotice !== null || examples.has(row.normalizedText))
      .map((row) => licenseKeyDigest(row.normalizedText))
  );
  return inspectLicensePreflight({
    source: options.source,
    reviewedRuleSelection: true,
    jsonClassifications: artifact.classifications,
    jsonNotices: [
      ...artifact.classifications.flatMap((row) =>
        row.exampleNotice === null ? [] : [row.exampleNotice]
      ),
      ...catalog,
    ],
    rerunRule: options.rerunRule?.filter((id) => available.has(id)),
    rerunModel: options.rerunModel?.filter((id) => available.has(id)),
    model: options.model,
    sampleCount: options.sampleCount,
    cacheDir: options.cacheDir,
    noCache: options.noCache,
  });
}

export async function loadedLicenseReview(
  inspection: LicenseInspection,
  options: LicenseCommandOptions,
  contentRevision: number
) {
  const snapshot = inspection.database;
  const artifact = snapshot
    ? await analyzeDatabaseLicenses({
        loadOnly: true,
        catalog: snapshot.context.resources.map(({ ttsLicenseStatus: _status, ...row }) => row),
        classifications: snapshot.classifications,
        model: options.model,
        sampleCount: options.sampleCount,
      })
    : parseLicenseArtifactBytes(inspection.inputBytes!);
  return freezeReviewValue({
    configurationRevision: inspection.configurationRevision,
    contentRevision,
    artifact,
    ...(snapshot ? {} : { originalSourceArtifact: artifact }),
  });
}

export function requirePracticeOptions(
  options: LicenseCommandOptions,
  practice: NonNullable<LicenseWorkflowDependencies['practice']>
) {
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

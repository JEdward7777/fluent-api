import { resolve } from 'node:path';

import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter, LicenseDatabaseSnapshot } from './license-database.types';
import type { LicenseFileIdentity } from './license-file-identity';
import type { LicenseFileIo } from './license-write';

import { matchesLicenseFile } from './license-file-identity';
interface InspectedSources {
  inputIdentity?: LicenseFileIdentity;
  outputIdentity?: LicenseFileIdentity;
  sourceOnly?: true;
  skipOutput?: boolean;
  inputBytes: string | null;
  outputBytes: string | null;
  database?: LicenseDatabaseSnapshot;
}

export class LicenseInspectionStaleError extends Error {
  constructor() {
    super('Inspected inputs changed. Inspect inputs again before starting analysis.');
    this.name = 'LicenseInspectionStaleError';
  }
}

export function comparableCatalog(context: LicenseDatabaseSnapshot['context']) {
  return { ...context, resources: context.resources.map((row) => JSON.stringify(row)).sort() };
}

function comparableDatabase(snapshot: LicenseDatabaseSnapshot | undefined) {
  if (!snapshot) return undefined;
  const byBytes = <T>(rows: T[]) => rows.map((row) => JSON.stringify(row)).sort();
  return {
    relation: snapshot.relation,
    tableExists: snapshot.tableExists,
    classifications: byBytes(snapshot.classifications),
    context: comparableCatalog(snapshot.context),
  };
}

export function sameLicenseDatabaseSnapshot(
  left?: LicenseDatabaseSnapshot,
  right?: LicenseDatabaseSnapshot
) {
  return JSON.stringify(comparableDatabase(left)) === JSON.stringify(comparableDatabase(right));
}

/** Recheck source, selected output and policy snapshot without rereading the model cache. */
export async function requireFreshLicenseSources(
  inspected: InspectedSources,
  options: LicenseCommandOptions,
  fs: LicenseFileIo,
  adapter?: LicenseDatabaseAdapter,
  destinationOnly = false,
  expectedSourceMarker?: string
) {
  const checkInput = !destinationOnly && options.source === 'json';
  if (checkInput && inspected.inputIdentity && !(await matchesLicenseFile(inspected.inputIdentity)))
    throw new LicenseInspectionStaleError();
  if (inspected.outputIdentity && !(await matchesLicenseFile(inspected.outputIdentity)))
    throw new LicenseInspectionStaleError();
  const inputBytes = checkInput
    ? await fs.read(inspected.inputIdentity?.canonical ?? options.input)
    : null;
  const outputBytes =
    inspected.sourceOnly || inspected.skipOutput
      ? null
      : resolve(options.output) === resolve(options.input) && checkInput
        ? inputBytes
        : await fs.read(inspected.outputIdentity?.canonical ?? options.output);
  if (
    (!destinationOnly && inputBytes !== inspected.inputBytes) ||
    outputBytes !== inspected.outputBytes
  )
    throw new LicenseInspectionStaleError();
  const database =
    !destinationOnly && options.source === 'database' && adapter?.loadSource
      ? await adapter?.load('source', expectedSourceMarker)
      : await adapter?.load();
  if (!sameLicenseDatabaseSnapshot(database, inspected.database))
    throw new LicenseInspectionStaleError();
  return { inputBytes, database };
}

export class LicenseDestinationRecheckError extends Error {
  constructor(cause: unknown) {
    super(
      'The save destination changed or could not be rechecked. Prepare a new preview before continuing.',
      { cause }
    );
  }
}

export async function requireFreshLicenseDestination(
  inspection: InspectedSources,
  options: LicenseCommandOptions,
  fs: LicenseFileIo,
  database?: LicenseDatabaseAdapter
) {
  try {
    await requireFreshLicenseSources(inspection, options, fs, database, true);
  } catch (error) {
    throw new LicenseDestinationRecheckError(error);
  }
}

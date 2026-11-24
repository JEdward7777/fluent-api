import { resolve } from 'node:path';

import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter, LicenseDatabaseSnapshot } from './license-database.types';
import type { LicenseFileIo } from './license-write';

interface InspectedSources {
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

function comparableDatabase(snapshot: LicenseDatabaseSnapshot | undefined) {
  if (!snapshot) return undefined;
  const byBytes = <T>(rows: T[]) => rows.map((row) => JSON.stringify(row)).sort();
  return {
    tableExists: snapshot.tableExists,
    classifications: byBytes(snapshot.classifications),
    context: { ...snapshot.context, resources: byBytes(snapshot.context.resources) },
  };
}

/** Recheck source, selected output and policy snapshot without rereading the model cache. */
export async function requireFreshLicenseSources(
  inspected: InspectedSources,
  options: LicenseCommandOptions,
  fs: LicenseFileIo,
  adapter?: LicenseDatabaseAdapter,
  destinationOnly = false
) {
  const checkInput = !destinationOnly && options.source === 'json';
  const inputBytes = checkInput ? await fs.read(options.input) : null;
  const outputBytes =
    inspected.sourceOnly || inspected.skipOutput
      ? null
      : resolve(options.output) === resolve(options.input) && checkInput
        ? inputBytes
        : await fs.read(options.output);
  if (
    (!destinationOnly && inputBytes !== inspected.inputBytes) ||
    outputBytes !== inspected.outputBytes
  )
    throw new LicenseInspectionStaleError();
  const database = adapter ? await adapter.load() : undefined;
  if (
    JSON.stringify(comparableDatabase(database)) !==
    JSON.stringify(comparableDatabase(inspected.database))
  )
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

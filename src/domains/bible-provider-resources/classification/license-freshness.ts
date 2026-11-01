import { resolve } from 'node:path';

import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter, LicenseDatabaseSnapshot } from './license-database.types';
import type { LicenseFileIo } from './license-write';

interface InspectedSources {
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
  adapter?: LicenseDatabaseAdapter
) {
  const inputBytes = options.source === 'json' ? await fs.read(options.input) : null;
  const outputBytes =
    resolve(options.output) === resolve(options.input) && options.source === 'json'
      ? inputBytes
      : await fs.read(options.output);
  if (inputBytes !== inspected.inputBytes || outputBytes !== inspected.outputBytes)
    throw new LicenseInspectionStaleError();
  const database = adapter ? await adapter.load() : undefined;
  if (
    JSON.stringify(comparableDatabase(database)) !==
    JSON.stringify(comparableDatabase(inspected.database))
  )
    throw new LicenseInspectionStaleError();
  return { inputBytes, database };
}

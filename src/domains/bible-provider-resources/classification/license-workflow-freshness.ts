import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type { LicenseInspection } from './license-workflow.types';
import type { LicenseFileIo } from './license-write';

import { checkLicenseArtifactReview } from '../license-artifact';
import { LicenseInspectionStaleError, requireFreshLicenseSources } from './license-freshness';
import { inspectLicensePreflight } from './license-preflight';

export class LicenseBootstrapRequiredError extends Error {
  constructor() {
    super(
      'Review required: an empty classification table bootstraps only from attested JSON. Export database-to-JSON, review it, then import that JSON.'
    );
    this.name = 'LicenseBootstrapRequiredError';
  }
}

export function parseLicenseArtifactBytes(bytes: string) {
  const checked = checkLicenseArtifactReview(JSON.parse(bytes));
  if (checked.status === 'invalid') throw new Error(checked.reason);
  return checked.artifact;
}

/** Analysis preflight must still describe the exact cache entries inspected. */
export async function requireFreshLicenseInspection(
  inspection: LicenseInspection,
  options: LicenseCommandOptions,
  fs: LicenseFileIo,
  database?: LicenseDatabaseAdapter
) {
  const fresh = await requireFreshLicenseSources(inspection, options, fs, database);
  const checked =
    options.source === 'json' ? checkLicenseArtifactReview(JSON.parse(fresh.inputBytes!)) : null;
  if (checked?.status === 'invalid') throw new Error(checked.reason);
  const preflight = await inspectLicensePreflight({
    database: options.source === 'database' ? fresh.database : undefined,
    jsonClassificationKeys: checked?.artifact.classifications.map((row) => row.normalizedText),
    model: options.model,
    sampleCount: options.sampleCount,
    cacheDir: options.cacheDir,
    noCache: options.noCache,
  });
  if (JSON.stringify(preflight) !== JSON.stringify(inspection.preflight))
    throw new LicenseInspectionStaleError();
}

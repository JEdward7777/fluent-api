import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type { LicenseInspection } from './license-workflow.types';
import type { LicenseFileIo } from './license-write';

import { checkLicenseArtifactReview } from '../license-artifact';
import { savedLicenseNotices } from '../license-normalizer';
import { LicenseInspectionStaleError, requireFreshLicenseSources } from './license-freshness';
import { inspectLicensePreflight } from './license-preflight';

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
    priorNotices:
      options.source === 'database' && inspection.outputBytes !== null
        ? savedLicenseNotices(parseLicenseArtifactBytes(inspection.outputBytes))
        : undefined,
    jsonClassifications: checked?.artifact.classifications,
    jsonNotices: checked?.artifact.catalog.flatMap((row) =>
      row.rawNotice?.trim() ? [row.rawNotice] : []
    ),
    rerunRule: options.rerunRule,
    rerunModel: options.rerunModel,
    model: options.model,
    sampleCount: options.sampleCount,
    cacheDir: options.cacheDir,
    noCache: options.noCache,
  });
  if (JSON.stringify(preflight) !== JSON.stringify(inspection.preflight))
    throw new LicenseInspectionStaleError();
}

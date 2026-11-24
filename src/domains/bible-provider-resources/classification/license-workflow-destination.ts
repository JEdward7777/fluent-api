import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type {
  LicenseAnalysis,
  LicenseInspection,
  LicenseWorkflowDependencies,
} from './license-workflow.types';

import { freezeReviewValue } from '../license-review-revision';
import { requireFreshLicenseSources } from './license-freshness';
import { buildLicenseSavePlan } from './license-save-plan';
import { licenseFileIo } from './license-write';

export class LicenseWorkflowDestination {
  database?: LicenseDatabaseAdapter;
  inspection?: LicenseInspection;
  async plan(
    inspection: LicenseInspection,
    analysis: LicenseAnalysis,
    options: LicenseCommandOptions,
    dependencies: LicenseWorkflowDependencies,
    sourceDatabase?: LicenseDatabaseAdapter
  ) {
    const sourceSnapshot = inspection.database;
    if (!dependencies.legacySkipFreshness)
      await requireFreshLicenseSources(
        inspection,
        options,
        dependencies.fs ?? licenseFileIo,
        sourceDatabase
      );
    if (inspection.sourceOnly) {
      if (!options.destination) throw new Error('Choose a save destination');
      if (options.destination !== 'json') {
        this.database ??= await dependencies.destinationDatabase!();
      }
      const database = await this.database?.load();
      if (options.destination !== 'json' && !database?.tableExists)
        throw new Error('The destination license_classifications table must exist');
      this.inspection = freezeReviewValue({
        ...inspection,
        sourceOnly: undefined,
        skipOutput: options.destination === 'database',
        outputBytes:
          options.destination === 'database'
            ? null
            : await (dependencies.fs ?? licenseFileIo).read(options.output),
        database,
      });
      inspection = this.inspection!;
    }
    return buildLicenseSavePlan({
      options,
      artifact: analysis.artifact,
      originalSourceArtifact: analysis.originalSourceArtifact,
      overwriteDatabase: dependencies.destinationDatabase ? false : undefined,
      inspectOutput: !inspection.skipOutput,
      inputBytes: inspection.inputBytes,
      outputBytes: inspection.outputBytes,
      database: inspection.database ?? sourceSnapshot,
    });
  }
  publication(source: LicenseInspection, sourceDatabase?: LicenseDatabaseAdapter) {
    return {
      loadedSource: source.sourceOnly
        ? { inspection: source, database: sourceDatabase }
        : undefined,
      inspection: this.inspection ?? source,
      database: this.inspection ? this.database : sourceDatabase,
    };
  }
  async closePools(source?: LicenseDatabaseAdapter) {
    try {
      await this.release(source);
    } finally {
      await source?.close?.();
    }
  }

  async release(source?: LicenseDatabaseAdapter) {
    if (this.database !== source) await this.database?.close?.();
    this.database = undefined;
    this.inspection = undefined;
  }
}

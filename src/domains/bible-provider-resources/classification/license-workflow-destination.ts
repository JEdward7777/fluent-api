import { resolve } from 'node:path';

import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type {
  LicenseAnalysis,
  LicenseInspection,
  LicenseWorkflowDependencies,
} from './license-workflow.types';

import { freezeReviewValue } from '../license-review-revision';
import { sameLicenseRelation } from './license-database-identity';
import { inspectLicenseFile, matchesLicenseFile, reviewerJsonRoot } from './license-file-identity';
import { LicenseInspectionStaleError, requireFreshLicenseSources } from './license-freshness';
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
    const sourceIdentity = inspection.inputIdentity;
    if (sourceIdentity && !(await matchesLicenseFile(sourceIdentity)))
      throw new LicenseInspectionStaleError();
    const targetIdentity =
      options.destination !== 'database' && (dependencies.fs ?? licenseFileIo) === licenseFileIo
        ? await inspectLicenseFile(options.output, reviewerJsonRoot(dependencies.practice))
        : undefined;
    if (targetIdentity?.links && targetIdentity.links !== '1')
      throw new Error('Cannot atomically publish a multiply linked JSON file');
    const sourceSnapshot = inspection.database;
    if (!dependencies.legacySkipFreshness)
      await requireFreshLicenseSources(
        inspection,
        options,
        dependencies.fs ?? licenseFileIo,
        sourceDatabase
      );
    if (inspection.sourceOnly && !options.destination) throw new Error('Choose a save destination');
    if (inspection.sourceOnly && options.destination !== 'json') {
      this.database ??= await dependencies.destinationDatabase!();
    }
    const targetDatabase = dependencies.destinationDatabase ? this.database : sourceDatabase;
    const challenge = sourceDatabase?.challenge?.(sourceSnapshot?.sourceMarker);
    const inspectedTarget =
      options.destination !== 'json'
        ? await targetDatabase?.inspectTarget?.(
            options.source === 'database' ? challenge : undefined
          )
        : undefined;
    if (inspection.sourceOnly) {
      const database =
        inspectedTarget?.snapshot ??
        (options.destination === 'json' ? undefined : await this.database?.load());
      if (options.destination !== 'json' && !database?.tableExists)
        throw new Error('The destination license_classifications table must exist');
      this.inspection = freezeReviewValue({
        ...inspection,
        sourceOnly: undefined,
        skipOutput: options.destination === 'database',
        outputIdentity: targetIdentity,
        outputBytes:
          options.destination === 'database'
            ? null
            : await (dependencies.fs ?? licenseFileIo).read(
                targetIdentity?.canonical ?? options.output
              ),
        database,
      });
      inspection = this.inspection!;
    }
    const proof =
      options.source === 'database' && options.destination !== 'json'
        ? ((inspectedTarget ? inspectedTarget.proof : await targetDatabase?.prove?.(challenge)) ?? {
            mode: 'unavailable' as const,
          })
        : undefined;
    if (
      proof?.source &&
      sourceSnapshot?.relation !== undefined &&
      !sameLicenseRelation(proof.source, sourceSnapshot.relation)
    )
      throw new LicenseInspectionStaleError();
    if (
      proof?.target &&
      inspection.database?.relation !== undefined &&
      !sameLicenseRelation(proof.target, inspection.database.relation)
    )
      throw new Error('Database destination changed during preview');
    const logicalSource = sourceIdentity?.canonical ?? resolve(options.input);
    const logicalTarget = targetIdentity?.canonical ?? resolve(options.output);
    if (targetIdentity && !(await matchesLicenseFile(targetIdentity)))
      throw new Error('JSON destination changed during preview');
    return {
      ...buildLicenseSavePlan({
        options: { ...options, input: logicalSource, output: logicalTarget },
        overwriteJson: options.source === 'json' && logicalSource === logicalTarget,
        artifact: analysis.artifact,
        originalSourceArtifact: analysis.originalSourceArtifact,
        overwriteDatabase: proof?.mode === 'same',
        inspectOutput: !inspection.skipOutput,
        inputBytes: inspection.inputBytes,
        outputBytes: inspection.outputBytes,
        database: inspectedTarget?.snapshot ?? inspection.database ?? sourceSnapshot,
      }),
      sourceIdentity,
      targetIdentity,
      databaseProof: proof,
      targetMarker: inspectedTarget?.marker,
    };
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

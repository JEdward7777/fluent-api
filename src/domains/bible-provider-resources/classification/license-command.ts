import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import type { LlmTransport } from '@/lib/llm/structured-request';

import type { LicenseReviewIo } from '../license-review.types';
import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type { LicenseFileIo } from './license-write';

import { checkLicenseArtifactReview } from '../license-artifact';
import { licenseInlineSummary } from '../license-report-model';
import { renderLicenseReports } from '../license-reports';
import { runLicenseReview } from '../license-review';
import { freezeReviewValue } from '../license-review-revision';
import { planLicenseDatabaseChanges } from './license-database-projection';
import { LicenseBootstrapRequiredError, LicenseWorkflow } from './license-workflow';
import { licenseFileIo, writeLicenseDestinations } from './license-write';

interface CommandDependencies {
  apiKey: string;
  interactive: boolean;
  io: LicenseReviewIo;
  fs?: LicenseFileIo;
  database?: () => Promise<LicenseDatabaseAdapter>;
  transport?: LlmTransport;
  openReport?: (path: string) => Promise<void>;
  now?: () => string;
}

/** Resolve configuration before analysis. No DB module is imported by the offline path. */
export async function runLicenseCommand(
  input: LicenseCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const { io } = dependencies;
  let database: LicenseDatabaseAdapter | undefined;
  let workflow: LicenseWorkflow | undefined;
  try {
    if (!dependencies.apiKey.trim())
      throw new Error('A nonempty GEMINI_API_KEY is required before reading any source');
    const options = freezeReviewValue(input);
    if (!options.source || !options.destination)
      throw new Error('Select both source and destination before analysis');
    const fs = dependencies.fs ?? licenseFileIo;
    workflow = new LicenseWorkflow(options, {
      apiKey: dependencies.apiKey,
      fs,
      database: dependencies.database,
      transport: dependencies.transport,
      now: dependencies.now,
      legacySkipFreshness: true,
    });
    const inspection = await workflow.inspect(workflow.status.configurationRevision);
    database = workflow.databaseAdapter;
    const snapshot = inspection.database;
    const { inputBytes, outputBytes } = inspection;
    const analysis = await workflow.startAnalysis(workflow.status.configurationRevision);
    let { artifact } = analysis;
    const { originalSourceArtifact } = analysis;
    if (inputBytes !== null)
      await io.write(
        `Untouched JSON source SHA-256: ${createHash('sha256').update(inputBytes).digest('hex')}`
      );
    const replace = options.source === 'json' && options.destination !== 'json';
    if (replace) {
      const changes = planLicenseDatabaseChanges(artifact, snapshot!.classifications);
      await io.write(
        `WARNING: whole-table license_classifications replacement: delete ${changes.deletedKeys.length}, insert ${changes.insertedKeys.length}, change ${changes.changedKeys.length} (status, rationale, producer or recorded evidence). No Bible/resource caches are written; the next ordinary sync derives them.`
      );
    }
    if (options.preserveExistingNonUnknowns)
      await io.write(
        'Preservation is a forecast only here. To preserve resource caches for one sync, run: npm run db:sync:dbl -- --preserve-existing-non-unknowns. A later ordinary sync may overwrite them.'
      );
    const config = {
      source: options.source,
      destination: options.destination,
      interactive: dependencies.interactive,
      yes: options.yes,
      formats: options.reportFormats,
      outputDir: options.reportDir,
      openReport: options.openReport,
      database: snapshot
        ? {
            ...snapshot.context,
            ...(replace
              ? { classificationTable: { existing: snapshot.classifications, replace: true } }
              : {}),
          }
        : undefined,
      preserveExistingNonUnknowns: options.preserveExistingNonUnknowns,
    };
    const emitReports = async (reports: ReturnType<typeof renderLicenseReports>) => {
      for (const report of reports.reports) {
        await fs.mkdir(dirname(report.path));
        await fs.write(report.path, report.bytes);
        await io.write(`Report: ${report.path}${report.url ? `\n${report.url}` : ''}`);
      }
    };
    let reports = renderLicenseReports(artifact, config);
    await emitReports(reports);
    await io.write(licenseInlineSummary(reports.model));
    if (replace && snapshot!.classifications.length && !options.force)
      throw new Error(
        'JSON import into a nonempty table requires --force; --yes does not imply --force'
      );
    if (options.openReport) {
      const html = reports.reports.find((report) => report.format === 'html')!;
      await dependencies.openReport?.(html.path);
    }
    const resultCode = () =>
      artifact.classifications.some((row) => row.status === 'unknown') ? 2 : 0;
    let write = options.yes;
    if (!options.planOnly && dependencies.interactive && !options.yes) {
      const reviewed = await runLicenseReview({
        artifact,
        config,
        io,
        regenerateReports: emitReports,
        now: dependencies.now,
        edit: (change) =>
          workflow!.editReview(
            change,
            workflow!.status.configurationRevision,
            workflow!.status.contentRevision
          ).analysis!.artifact,
        preview: async () =>
          (
            await workflow!.preview(
              workflow!.status.configurationRevision,
              workflow!.status.contentRevision
            )
          ).reports,
        attest: (metadata, reviewHash) =>
          workflow!.attest(
            metadata,
            workflow!.status.configurationRevision,
            workflow!.status.contentRevision,
            reviewHash
          ).artifact,
      });
      artifact = reviewed.artifact;
      reports = reviewed.reports;
      if (reviewed.action === 'review-required') return 3;
      write = reviewed.writeIntent;
    }
    if (options.yes && options.reviewer?.trim() && options.reviewReason?.trim()) {
      // Unknowns require genuine row notes; unattended signing never invents them.
      if (!artifact.classifications.some((row) => row.status === 'unknown' && !row.rowNote))
        artifact = workflow.attest(
          {
            reviewedBy: options.reviewer,
            reviewReason: options.reviewReason,
            reviewedAt: dependencies.now?.() ?? new Date().toISOString(),
          },
          workflow.status.configurationRevision,
          workflow.status.contentRevision,
          (
            await workflow.preview(
              workflow.status.configurationRevision,
              workflow.status.contentRevision
            )
          ).reports.reviewContentHash
        ).artifact;
    }
    reports = renderLicenseReports(artifact, config);
    await emitReports(reports);
    await io.write(
      `Planned JSON SHA-256: ${reports.wholeFileHash}; review hash: ${artifact.reviewContentHash}`
    );
    // Plan-only and noninteractive previews may emit a visibly incomplete work artifact.
    // Cross-only valid imports never rewrite their source merely to produce a preview.
    const jsonDestination = options.destination !== 'database';
    if (replace && checkLicenseArtifactReview(artifact).status !== 'ready') {
      await io.write(
        'Review required; no database rows changed. Supply --yes --reviewer=NAME --review-reason=REASON for this exact revision, and add a human row note for every retained unknown. --force never bypasses review.'
      );
      return 3;
    }
    if (options.planOnly || !write) {
      if (jsonDestination && (!dependencies.interactive || options.planOnly))
        await writeLicenseDestinations({
          artifact,
          files: [{ path: options.output, previous: outputBytes }],
          replace: false,
          fs,
        });
      return resultCode();
    }
    const files: { path: string; previous: string | null }[] = jsonDestination
      ? [{ path: options.output, previous: outputBytes }]
      : [];
    // Signing an imported JSON is the explicit cross-only no-rewrite exception.
    const signedSource =
      originalSourceArtifact !== undefined &&
      checkLicenseArtifactReview(artifact).status === 'ready' &&
      (originalSourceArtifact.reviewContentHash !== artifact.reviewContentHash ||
        originalSourceArtifact.reviewState !== artifact.reviewState ||
        JSON.stringify(originalSourceArtifact.attestation) !==
          JSON.stringify(artifact.attestation));
    if (signedSource && !files.some((file) => resolve(file.path) === resolve(options.input)))
      files.push({ path: options.input, previous: inputBytes });
    await writeLicenseDestinations({
      artifact,
      files,
      database: options.destination !== 'json' ? database : undefined,
      replace,
      force: options.force,
      fs,
    });
    await io.write(
      `Wrote decisions to ${options.destination}${files.length ? `; JSON: ${files.map((file) => file.path).join(', ')}` : ''}. Resource caches update on the next ordinary sync.`
    );
    return resultCode();
  } catch (error) {
    await io.write(error instanceof Error ? error.message : String(error));
    return error instanceof LicenseBootstrapRequiredError ? 3 : 1;
  } finally {
    await workflow?.close();
  }
}

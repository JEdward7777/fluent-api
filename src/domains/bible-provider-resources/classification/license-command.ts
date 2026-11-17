import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

import type { LlmTransport } from '@/lib/llm/structured-request';

import type { LicenseReviewIo } from '../license-review.types';
import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type { LicenseFileIo } from './license-write';

import { licenseInlineSummary } from '../license-report-model';
import { renderLicenseReports } from '../license-reports';
import { runLicenseReview } from '../license-review';
import { freezeReviewValue } from '../license-review-revision';
import { LicenseWorkflow } from './license-workflow';
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
  let workflow: LicenseWorkflow | undefined;
  try {
    if (!dependencies.apiKey.trim())
      throw new Error('A nonempty GOOGLE_AI_API_KEY is required before reading any source');
    const options = freezeReviewValue(input);
    if (!options.source || !options.destination)
      throw new Error('Select both source and destination before analysis');
    if (options.reviewer || options.reviewReason)
      throw new Error(
        '--reviewer and --review-reason cannot attest a batch; use a named per-row human decision'
      );
    const fs = dependencies.fs ?? licenseFileIo;
    workflow = new LicenseWorkflow(options, {
      apiKey: dependencies.apiKey,
      fs,
      database:
        dependencies.database ??
        (() =>
          import('./license-classifications.service').then((module) =>
            module.createLicenseDatabaseAdapter()
          )),
      transport: dependencies.transport,
      now: dependencies.now,
    });
    const inspection = await workflow.inspect(workflow.status.configurationRevision);
    const snapshot = inspection.database;
    const { inputBytes } = inspection;
    const analysis = await workflow.startAnalysis(workflow.status.configurationRevision);
    let { artifact } = analysis;
    if (inputBytes !== null)
      await io.write(
        `Untouched JSON source SHA-256: ${createHash('sha256').update(inputBytes).digest('hex')}`
      );
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
            ...(options.destination !== 'json'
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
        attest: (metadata, _reviewHash) =>
          workflow!.attest(
            metadata,
            workflow!.status.configurationRevision,
            workflow!.status.contentRevision,
            workflow!.analyzed!.artifact.reviewContentHash
          ).artifact,
      });
      artifact = reviewed.artifact;
      reports = reviewed.reports;
      if (reviewed.action === 'review-required') return 3;
      write = reviewed.writeIntent;
    }
    const preview = await workflow.preview(
      workflow.status.configurationRevision,
      workflow.status.contentRevision
    );
    await emitReports(preview.reports);
    await io.write(
      `Planned JSON SHA-256: ${preview.plan.wholeFileHash}; review hash: ${preview.plan.reviewContentHash}`
    );
    if (preview.plan.conflicts.length) {
      await io.write(`Save conflicts: ${preview.plan.conflicts.join('; ')}`);
      return 3;
    }
    if (options.planOnly || !write) {
      if (preview.plan.jsonArtifact)
        await writeLicenseDestinations({
          artifact: preview.plan.jsonArtifact,
          files: preview.plan.targets.map(({ path, previous }) => ({ path, previous })),
          replace: false,
          fs,
          expectedFiles: preview.plan.expectedFiles,
        });
      if (options.openReport) {
        const html = preview.reports.reports.find((report) => report.format === 'html');
        if (html) await dependencies.openReport?.(html.path);
      }
      return resultCode();
    }
    await workflow.save({
      operationId: `cli-${createHash('sha256')
        .update(JSON.stringify([options.input, options.output, preview.plan.wholeFileHash]))
        .digest('hex')}`,
      configurationRevision: workflow.status.configurationRevision,
      contentRevision: workflow.status.contentRevision,
      agreeToReplace: false,
    });
    if (options.openReport) {
      const html = preview.reports.reports.find((report) => report.format === 'html');
      if (html) await dependencies.openReport?.(html.path);
    }
    await io.write(
      `Wrote decisions to ${options.destination}${preview.plan.targets.length ? `; JSON: ${preview.plan.targets.map((target) => target.path).join(', ')}` : ''}. Resource caches update on the next ordinary sync.`
    );
    return resultCode();
  } catch (error) {
    await io.write(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await workflow?.close();
  }
}

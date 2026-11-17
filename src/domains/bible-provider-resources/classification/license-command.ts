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
import { licenseKeyDigest } from './license-eligibility';
import { inspectLicensePreflight } from './license-preflight';
import { LicenseWorkflow } from './license-workflow';
import { parseLicenseArtifactBytes } from './license-workflow-freshness';
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
    await io.write(
      `Preflight: ${inspection.preflight.distinctKeys} keys; ${inspection.preflight.ruleHits} rule matches; ${inspection.preflight.modelKeys} model keys; ${inspection.preflight.validCacheHits} valid cached samples; ${inspection.preflight.expectedUncachedRequests} expected uncached requests, up to ${inspection.preflight.maximumAttempts} attempts. ${inspection.preflight.rows
        .filter((row) => row.action !== 'retain')
        .map(
          (row) =>
            `${licenseKeyDigest(row.normalizedText)}:${row.action}${row.ruleMatches ? ':rule-match' : ':rule-nonmatch'}`
        )
        .join(' ')}`
    );
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
      database: snapshot?.context,
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
        reassess: async (key, kind) => {
          const digest = licenseKeyDigest(key);
          const nextOptions: LicenseCommandOptions = {
            ...options,
            rerunRule: kind === 'rule' ? [digest] : [],
            rerunModel: kind === 'model' ? [digest] : [],
          };
          const saved = inputBytes === null ? undefined : parseLicenseArtifactBytes(inputBytes);
          const estimate = await inspectLicensePreflight({
            database: options.source === 'database' ? inspection.database : undefined,
            jsonClassifications: saved?.classifications,
            jsonNotices: saved?.catalog.flatMap((row) =>
              row.rawNotice?.trim() ? [row.rawNotice] : []
            ),
            rerunRule: nextOptions.rerunRule,
            rerunModel: nextOptions.rerunModel,
            model: options.model,
            sampleCount: options.sampleCount,
            cacheDir: options.cacheDir,
            noCache: options.noCache,
          });
          const row = estimate.rows.find((entry) => entry.normalizedText === key)!;
          await io.write(
            `${kind} reassessment for ${JSON.stringify(key)}: ${row.ruleMatches ? 'rule match' : 'rule nonmatch'}; ${estimate.validCacheHits} valid cached samples, ${estimate.expectedUncachedRequests} expected uncached requests, up to ${estimate.maximumAttempts} attempts. Current unsaved row edits will be discarded.`
          );
          const answer = await io.ask('Select this reassessment and continue to Analyze? [y/N] ');
          if (!['y', 'yes'].includes(answer.trim().toLowerCase())) return null;
          await workflow!.configure(nextOptions, workflow!.status.configurationRevision, true);
          const fresh = await workflow!.inspect(workflow!.status.configurationRevision);
          if (JSON.stringify(fresh.preflight) !== JSON.stringify(estimate))
            throw new Error('Preflight changed; Inspect again before reassessment');
          await io.write('Inspected selection is unchanged. Starting the selected analysis.');
          return (await workflow!.startAnalysis(workflow!.status.configurationRevision)).artifact;
        },
        assertWholeArtifact: (metadata, reviewHash) =>
          workflow!.attest(
            metadata,
            workflow!.status.configurationRevision,
            workflow!.status.contentRevision,
            reviewHash
          ).artifact,
        preview: async () =>
          (
            await workflow!.preview(
              workflow!.status.configurationRevision,
              workflow!.status.contentRevision
            )
          ).reports,
      });
      artifact = reviewed.artifact;
      reports = reviewed.reports;
      write = reviewed.writeIntent;
    }
    const preview = await workflow.preview(
      workflow.status.configurationRevision,
      workflow.status.contentRevision
    );
    await emitReports(preview.reports);
    const changes = (label: string, operation: string, value: typeof preview.plan.jsonChanges) =>
      `${label} ${operation}: ${value.inserted.length} inserts, ${value.updated.length} updates, ${value.preserved.length} preserved, ${value.unchanged.length} unchanged`;
    await io.write(
      preview.plan.jsonArtifact
        ? changes(
            'JSON',
            options.source === 'json' ? 'overwrite' : 'sync',
            preview.plan.jsonChanges
          )
        : 'JSON remains unchanged'
    );
    await io.write(
      preview.plan.databaseArtifact
        ? changes(
            'Database',
            options.source === 'database' ? 'overwrite' : 'sync',
            preview.plan.databaseChanges
          )
        : 'Database remains unchanged'
    );
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
      return 0;
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
    return 0;
  } catch (error) {
    await io.write(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await workflow?.close();
  }
}

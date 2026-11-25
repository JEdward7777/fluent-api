import { createHash, randomUUID } from 'node:crypto';
import { lstat, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type { LicenseSavePlan } from './license-save-plan';
import type {
  LicenseInspection,
  LicensePreview,
  LicenseReportExportRequest,
  LicenseReportExportResult,
} from './license-workflow.types';
import type { LicenseFileIo } from './license-write';

import { renderLicenseHtml } from '../license-report-html';
import { renderLicenseMarkdown } from '../license-report-markdown';
import { freezeReviewValue } from '../license-review-revision';
import {
  LicenseDestinationRecheckError,
  requireFreshLicenseDestination,
  requireFreshLicenseSources,
} from './license-freshness';
import { inspectReportDirectory, withReportDirectory } from './license-report-directory';
import { licenseFileIo } from './license-write';

/** Physical entry and version bound to the overwrite agreement (including same-byte replacements). */
export async function reportTargetIdentity(path: string): Promise<string | null> {
  const entry = await lstat(path, { bigint: true }).catch((error) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) return null;
  const file = entry.isSymbolicLink() ? await stat(path, { bigint: true }) : entry;
  if (!file.isFile()) throw new Error('Choose a regular file as the report target.');
  return [
    entry.dev,
    entry.ino,
    entry.ctimeNs,
    file.dev,
    file.ino,
    file.birthtimeNs,
    file.ctimeNs,
  ].join(':');
}

export function reportTargetChanged(path: string) {
  return new Error(`Report target changed: ${path}. Check the target again before exporting.`);
}

/** Check the bytes and independent policy result actually published by the completed Save. */
export function requireSavedReportTargets(saved: LicenseSavePlan, current: LicenseSavePlan) {
  const file = current.targets[0];
  if (
    (file &&
      (file.previous === null ||
        file.path !== saved.targets[0]?.path ||
        createHash('sha256').update(file.previous).digest('hex') !== saved.wholeFileHash)) ||
    current.databaseChanges.inserted.length ||
    current.databaseChanges.updated.length ||
    current.conflicts.length ||
    current.impactContextHash !== saved.impactContextHash ||
    current.databaseForecast?.reviewContentHash !== saved.databaseForecast?.reviewContentHash
  )
    throw new LicenseDestinationRecheckError(
      'The published targets no longer match the saved report.'
    );
}

/** An explicit report publication, independent of artifact Save and in-memory preview. */
export async function exportPreviewedLicenseReport(input: {
  request: LicenseReportExportRequest;
  preview: LicensePreview;
  inspection: LicenseInspection;
  options: LicenseCommandOptions;
  database?: LicenseDatabaseAdapter;
  loadedSource?: { inspection: LicenseInspection; database?: LicenseDatabaseAdapter };
  fs?: LicenseFileIo;
}): Promise<LicenseReportExportResult> {
  const { request, preview, inspection, options, database } = input;
  const fs = input.fs ?? licenseFileIo;
  const recheck = async () => {
    if (input.loadedSource) {
      await requireFreshLicenseSources(
        input.loadedSource.inspection,
        options,
        fs,
        input.loadedSource.database
      );
      await requireFreshLicenseDestination(inspection, options, fs, database);
    } else await requireFreshLicenseSources(inspection, options, fs, database);
  };
  if (!request.path.trim()) throw new Error('Report export path is required');
  const path = resolve(request.path);
  const bytes =
    request.format === 'html'
      ? renderLicenseHtml(preview.reports.model)
      : renderLicenseMarkdown(preview.reports.model);
  if (request.expectedPreviousBytes !== null && !request.agreeToOverwrite)
    throw new Error('Explicit agreement is required to overwrite an existing report');
  const directory = request.reportDirectory ?? (await inspectReportDirectory(dirname(path)));
  const canonical = join(directory.canonical, basename(path));
  if (preview.plan.expectedFiles.some((file) => file.path === path || file.path === canonical))
    throw new Error('Report export path must differ from source and artifact paths');
  const identity =
    request.expectedReportIdentity === undefined
      ? await reportTargetIdentity(canonical)
      : request.expectedReportIdentity;
  const checkTarget = async (target: string) => {
    if (
      (await fs.read(target)) !== request.expectedPreviousBytes ||
      (await reportTargetIdentity(target)) !== identity ||
      (identity === null) !== (request.expectedPreviousBytes === null)
    )
      throw reportTargetChanged(path);
  };
  await recheck();
  await checkTarget(canonical);
  await withReportDirectory(dirname(path), directory, fs.mkdir, async (physical, verify) => {
    const target = join(physical, basename(path));
    const temporary = `${target}.${randomUUID()}.tmp`;
    let staged = false;
    try {
      await fs.write(temporary, bytes, () => {
        staged = true;
      });
      await recheck();
      await checkTarget(target);
      await verify();
      if (identity !== null) {
        // POSIX rename has no compare-and-swap for an existing name. Recheck its identity
        // and bytes immediately before atomic replacement.
        await fs.rename(temporary, target);
        staged = false;
      } else {
        if (!fs.link)
          throw new Error(
            'This filesystem cannot publish a new report without replacing an existing file.'
          );
        try {
          await fs.link(temporary, target);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
            throw reportTargetChanged(path);
          throw error;
        }
      }
    } finally {
      try {
        if (staged) {
          await verify(false);
          await fs.remove(temporary);
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          console.warn(`Could not remove temporary license report ${temporary}`);
      }
    }
  });
  return freezeReviewValue({
    operationId: request.operationId,
    configurationRevision: request.configurationRevision,
    contentRevision: request.contentRevision,
    path,
    format: request.format,
    bytes,
  });
}

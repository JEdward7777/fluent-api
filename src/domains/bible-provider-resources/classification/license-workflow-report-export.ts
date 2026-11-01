import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
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
import { requireFreshLicenseSources } from './license-freshness';
import { LicenseFileDriftError, licenseFileIo } from './license-write';

/** An explicit report publication, independent of artifact Save and in-memory preview. */
export async function exportPreviewedLicenseReport(input: {
  request: LicenseReportExportRequest;
  preview: LicensePreview;
  inspection: LicenseInspection;
  options: LicenseCommandOptions;
  database?: LicenseDatabaseAdapter;
  fs?: LicenseFileIo;
}): Promise<LicenseReportExportResult> {
  const { request, preview, inspection, options, database } = input;
  const fs = input.fs ?? licenseFileIo;
  if (!request.path.trim()) throw new Error('Report export path is required');
  const path = resolve(request.path);
  if (preview.plan.expectedFiles.some((file) => file.path === path))
    throw new Error('Report export path must differ from source and artifact paths');
  const bytes =
    request.format === 'html'
      ? renderLicenseHtml(preview.reports.model)
      : renderLicenseMarkdown(preview.reports.model);
  if (request.expectedPreviousBytes !== null && !request.agreeToOverwrite)
    throw new Error('Explicit agreement is required to overwrite an existing report');
  await requireFreshLicenseSources(inspection, options, fs, database);
  if ((await fs.read(path)) !== request.expectedPreviousBytes)
    throw new LicenseFileDriftError(path);
  await fs.mkdir(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.write(temporary, bytes);
    await requireFreshLicenseSources(inspection, options, fs, database);
    if ((await fs.read(path)) !== request.expectedPreviousBytes)
      throw new LicenseFileDriftError(path);
    await fs.rename(temporary, path);
  } finally {
    try {
      await fs.remove(temporary);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        console.warn(`Could not remove temporary license report ${temporary}`);
    }
  }
  return freezeReviewValue({
    operationId: request.operationId,
    configurationRevision: request.configurationRevision,
    contentRevision: request.contentRevision,
    path,
    format: request.format,
  });
}

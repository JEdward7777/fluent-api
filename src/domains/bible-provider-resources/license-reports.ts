import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { LicenseDatabaseContext } from './license-impact';

import { selectLicenseReportFormats } from './license-report-formats';
import { renderLicenseHtml } from './license-report-html';
import { renderLicenseMarkdown } from './license-report-markdown';
import { buildLicenseReportModel } from './license-report-model';
import { freezeReviewValue } from './license-review-revision';

export interface LicenseReportOptions {
  formats?: string;
  outputDir?: string;
  database?: LicenseDatabaseContext;
  preserveExistingNonUnknowns?: boolean;
  interactive?: boolean;
  yes?: boolean;
  openReport?: boolean;
}

/** Return previews and paths only; callers own filesystem writes and explicit browser actions. */
export function renderLicenseReports(value: unknown, options: LicenseReportOptions = {}) {
  const formats = selectLicenseReportFormats(options.formats, options);
  const outputDir = options.outputDir ?? join('.temp', 'license-reports');
  if (!outputDir.trim()) throw new Error('Report output directory must not be empty');
  const model = buildLicenseReportModel(
    value,
    options.database,
    options.preserveExistingNonUnknowns
  );
  const reports = formats.map((format) => {
    const path = join(outputDir, `license-impact.${format === 'html' ? 'html' : 'md'}`);
    return {
      format,
      path,
      url: format === 'html' ? pathToFileURL(resolve(path)).href : null,
      bytes: format === 'html' ? renderLicenseHtml(model) : renderLicenseMarkdown(model),
    };
  });
  return freezeReviewValue({
    artifact: model.artifact,
    artifactBytes: model.artifactBytes,
    reviewContentHash: model.reviewContentHash,
    wholeFileHash: model.wholeFileHash,
    model,
    reports,
    openRequested: options.openReport ?? false,
  });
}
export type LicenseReportBundle = ReturnType<typeof renderLicenseReports>;

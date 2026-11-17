import type { LicenseReviewEdit } from './classification/license-workflow';
import type { LicenseArtifact } from './license-artifact.schemas';
import type { LicenseReportBundle, LicenseReportOptions } from './license-reports';
import type { LicenseReviewIo } from './license-review.types';

import {
  attestLicenseArtifact,
  checkLicenseArtifactReview,
  serializeLicenseArtifact,
} from './license-artifact';
import { selectLicenseReportFormats } from './license-report-formats';
import { licenseInlineSummary } from './license-report-model';
import { renderLicenseReports } from './license-reports';
import { freezeLicenseRevision, freezeReviewValue } from './license-review-revision';
import { reviewLicenseRows } from './license-review-rows';

interface ReviewConfig extends LicenseReportOptions {
  source: 'json' | 'database';
  destination: 'json' | 'database' | 'both';
  interactive: boolean;
}
interface ReviewOptions {
  artifact: unknown;
  config: ReviewConfig;
  io: LicenseReviewIo;
  regenerateReports?: (reports: LicenseReportBundle) => Promise<void>;
  now?: () => string;
  edit?: (change: LicenseReviewEdit) => LicenseArtifact;
  reassess?: (key: string, kind: 'rule' | 'model') => Promise<LicenseArtifact | null>;
  assertWholeArtifact?: (
    metadata: { reviewedBy: string; reviewReason: string; reviewedAt: string },
    reviewHash: string
  ) => LicenseArtifact;
  preview?: () => Promise<LicenseReportBundle>;
}
const yes = (answer: string) => ['y', 'yes'].includes(answer.trim().toLowerCase());

/** Analyze before calling: this controller has no source-read, inference, database, or browser API. */
export async function runLicenseReview(options: ReviewOptions) {
  const config = freezeReviewValue(options.config);
  selectLicenseReportFormats(config.formats, config);
  if (!config.interactive || config.yes)
    throw new Error('Interactive review is unavailable without a terminal or with --yes');
  if (
    !['json', 'database'].includes(config.source) ||
    !['json', 'database', 'both'].includes(config.destination)
  )
    throw new Error('Resolve a valid source and destination before review');
  if ((config.source === 'database' || config.destination !== 'json') && !config.database)
    throw new Error('A selected database source or destination requires its actual impact context');
  const { io } = options;
  let artifact = freezeLicenseRevision(options.artifact);
  let reports = renderLicenseReports(artifact, config);
  const regenerate = async () => {
    reports = options.preview ? await options.preview() : renderLicenseReports(artifact, config);
    await options.regenerateReports?.(reports);
    await io.write(licenseInlineSummary(reports.model));
    for (const report of reports.reports)
      await io.write(`Report: ${report.path}${report.url ? `\n${report.url}` : ''}`);
  };
  await regenerate();
  const finish = (action: 'write' | 'quit') =>
    freezeReviewValue({
      action,
      writeIntent: action === 'write',
      artifact,
      config,
      reports,
      reviewStatus: checkLicenseArtifactReview(artifact).status,
      attestationDeclined: false,
    });
  while (true) {
    const command = (
      await io.ask(
        '[W] Write current decisions  [R] Review or edit classifications  [A] Optional whole-file assertion  [Q] Quit: '
      )
    )
      .trim()
      .toUpperCase();
    if (!command || command === 'Q') return finish('quit');
    if (command === 'R') {
      const edited = await reviewLicenseRows(
        artifact,
        io,
        config.database,
        config.preserveExistingNonUnknowns,
        options.edit,
        options.reassess
      );
      if (serializeLicenseArtifact(edited).wholeFileHash !== reports.wholeFileHash) {
        artifact = freezeLicenseRevision(edited);
        await regenerate();
      } else await options.preview?.();
      continue;
    }
    if (command === 'A') {
      const reviewedBy = await io.ask('Name for optional whole-file assertion: ');
      const reviewReason = await io.ask('Reason and scope of this assertion: ');
      if (!reviewedBy.trim() || !reviewReason.trim()) {
        await io.write('Name and reason are required; no assertion was added.');
        continue;
      }
      const metadata = {
        reviewedBy,
        reviewReason,
        reviewedAt: options.now?.() ?? new Date().toISOString(),
      };
      artifact = options.assertWholeArtifact
        ? options.assertWholeArtifact(metadata, artifact.reviewContentHash)
        : freezeLicenseRevision(attestLicenseArtifact(artifact, metadata));
      await regenerate();
      continue;
    }
    if (command !== 'W') {
      await io.write('Choose W, R, A, or Q.');
      continue;
    }
    const accepted = yes(
      await io.ask(
        `Write the previewed decisions to ${config.destination}? Review hash ${artifact.reviewContentHash}, file SHA-256 ${reports.wholeFileHash}. [y/N] `
      )
    );
    if (accepted) return finish('write');
    await io.write('Write canceled; no classifications were written.');
  }
}

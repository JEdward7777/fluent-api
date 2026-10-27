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
    reports = renderLicenseReports(artifact, config);
    await options.regenerateReports?.(reports);
    await io.write(licenseInlineSummary(reports.model));
    for (const report of reports.reports)
      await io.write(`Report: ${report.path}${report.url ? `\n${report.url}` : ''}`);
  };
  await regenerate();
  const finish = (action: 'write' | 'quit' | 'review-required', attestationDeclined = false) =>
    freezeReviewValue({
      action,
      writeIntent: action === 'write',
      artifact,
      config,
      reports,
      reviewStatus: checkLicenseArtifactReview(artifact).status,
      attestationDeclined,
    });
  while (true) {
    const command = (
      await io.ask(
        '[W] Write current decisions  [R] Review or edit classifications  [Q] Quit without writing classifications: '
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
        config.preserveExistingNonUnknowns
      );
      if (serializeLicenseArtifact(edited).wholeFileHash !== reports.wholeFileHash) {
        artifact = freezeLicenseRevision(edited);
        await regenerate();
      }
      continue;
    }
    if (command !== 'W') {
      await io.write('Choose W, R, or Q.');
      continue;
    }
    let attestationDeclined = false;
    if (checkLicenseArtifactReview(artifact).status !== 'ready') {
      const accept = yes(
        await io.ask(
          `Have you spot-checked this exact revision ${artifact.reviewContentHash} and accept review responsibility? [y/N] `
        )
      );
      if (accept) {
        if (artifact.classifications.some((row) => row.status === 'unknown' && !row.rowNote)) {
          await io.write(
            'Every retained unknown needs a human row note. Use Review before completing JSON.'
          );
          continue;
        }
        const reviewedBy = await io.ask('Reviewer identity (required): ');
        const reviewReason = await io.ask(
          'Reason/scope of this exact-revision review (required): '
        );
        if (!reviewedBy.trim() || !reviewReason.trim()) {
          await io.write('Identity and review reason are required; no attestation was added.');
          continue;
        }
        artifact = freezeLicenseRevision(
          attestLicenseArtifact(artifact, {
            reviewedBy,
            reviewReason,
            reviewedAt: options.now?.() ?? new Date().toISOString(),
          })
        );
      } else {
        attestationDeclined = true;
        if (config.source === 'json' && config.destination !== 'json') {
          await io.write(
            'Review required. This JSON revision is incomplete; no database rows will change.'
          );
          await regenerate();
          return finish('review-required', true);
        }
        await io.write('No review attestation was added. The JSON revision remains incomplete.');
      }
      // Attestation changes final JSON bytes even when its owned review hash is unchanged.
      await regenerate();
    }
    const state = checkLicenseArtifactReview(artifact).status;
    const accepted = yes(
      await io.ask(
        `Write these decisions to ${config.destination}? Review hash ${artifact.reviewContentHash}, file SHA-256 ${reports.wholeFileHash}, JSON review ${state === 'ready' ? 'attested' : 'incomplete'}. [y/N] `
      )
    );
    if (accepted) return finish('write', attestationDeclined);
    await io.write('Write canceled; no classifications were written.');
  }
}

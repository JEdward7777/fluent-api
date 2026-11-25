import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseReviewQuery } from './license-workbench-review';
import type { LicenseWorkflow } from './license-workflow';

import {
  getLicenseWorkbenchReviewDetail,
  listLicenseWorkbenchReview,
} from './license-workbench-review';

export function licenseWorkbenchReviewList(
  workflow: LicenseWorkflow | undefined,
  configurationRevision: number,
  options: LicenseCommandOptions,
  query: LicenseReviewQuery
) {
  const analysis = workflow?.analyzed;
  if (!analysis) throw new Error('Start analysis before reviewing evidence');
  return {
    epoch: workflow?.reviewDrafts.epoch,
    configurationRevision,
    contentRevision: analysis.contentRevision,
    ...listLicenseWorkbenchReview(
      analysis.artifact,
      query,
      workflow?.reviewDatabaseContext,
      options.preserveExistingNonUnknowns,
      workflow?.reviewDrafts
    ),
  };
}

export function licenseWorkbenchReviewDetail(
  workflow: LicenseWorkflow | undefined,
  configurationRevision: number,
  options: LicenseCommandOptions,
  id: string,
  query?: LicenseReviewQuery
) {
  const analysis = workflow?.analyzed;
  if (!analysis) throw new Error('Start analysis before reviewing evidence');
  const detail = getLicenseWorkbenchReviewDetail(
    analysis.artifact,
    id,
    workflow?.reviewDatabaseContext,
    options.preserveExistingNonUnknowns,
    workflow?.reviewDrafts
  );
  if (!detail) throw new Error('Review row was not found');
  const view =
    query &&
    listLicenseWorkbenchReview(
      analysis.artifact,
      query,
      workflow?.reviewDatabaseContext,
      options.preserveExistingNonUnknowns,
      workflow?.reviewDrafts,
      detail.normalizedText
    );
  return {
    ...detail,
    ...(view && { navigation: view.navigation, remaining: view.remaining, total: view.total }),
    epoch: workflow?.reviewDrafts.epoch,
    configurationRevision,
    contentRevision: analysis.contentRevision,
  };
}

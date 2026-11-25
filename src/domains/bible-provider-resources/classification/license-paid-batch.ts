import { createGoogleTransport } from '@/lib/llm/google-transport';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseEligibilityRow } from './license-eligibility';
import type { stageFreePreparation } from './license-free-preparation';
import type { LicenseWorkflowDependencies } from './license-workflow.types';

import { createLicenseClassifier } from '../license-classifier';
import { assessJsonLicenseRows, LicenseAnalysisStoppedError } from './license-analysis';
import { licenseKeyDigest } from './license-eligibility';

export interface PaidAuthorization {
  fingerprint: string;
  maximumRequests: number;
  replacementConfirmations: string[];
}

export class PaidBatchError extends Error {}

export async function stagePaidBatch(input: {
  staged: Awaited<ReturnType<typeof stageFreePreparation>>;
  authorization: PaidAuthorization;
  artifact: LicenseArtifact;
  options: LicenseCommandOptions;
  eligibility: LicenseEligibilityRow[];
  dependencies: LicenseWorkflowDependencies;
  stop: () => boolean;
  progress: { attempts: number; completedRows: number };
}) {
  const { staged, authorization, dependencies, options, progress } = input;
  const { estimate } = staged;
  if (
    estimate.fingerprint !== authorization.fingerprint ||
    !estimate.expectedUncachedRequests ||
    estimate.expectedUncachedRequests !== authorization.maximumRequests
  )
    throw new PaidBatchError('Estimate changed. Prepare free evidence before authorizing a batch.');
  const confirmations = estimate.outstanding
    .flatMap((row) => row.replacementConfirmation ?? [])
    .sort();
  if (
    JSON.stringify(confirmations) !==
    JSON.stringify([...authorization.replacementConfirmations].sort())
  )
    throw new PaidBatchError('Confirm the selected human replacements for this estimate.');
  if (!dependencies.apiKey.trim() || dependencies.practice)
    throw new Error('GOOGLE_AI_API_KEY is required for a paid batch');
  const outstanding = new Set(estimate.outstanding.map((row) => row.id));
  const notices = new Map(input.eligibility.map((row) => [row.normalizedText, row.exampleNotice]));
  const eligibility = input.artifact.classifications
    .filter((row) => outstanding.has(licenseKeyDigest(row.normalizedText)))
    .map((row) => ({
      normalizedText: row.normalizedText,
      exampleNotice: notices.get(row.normalizedText) ?? row.exampleNotice!,
      action: 'model' as const,
      reason: 'Authorized paid classification',
      savedEvidenceReuse: false,
      ruleMatches: false,
    }));
  const transport = dependencies.transport ?? createGoogleTransport(dependencies.apiKey);
  const classify = createLicenseClassifier({
    ...options,
    apiKey: dependencies.apiKey,
    plannedResponses: staged.responses,
    transport: (request) => {
      if (input.stop()) throw new LicenseAnalysisStoppedError();
      if (progress.attempts >= estimate.maximumAttempts)
        throw new PaidBatchError('Approved attempt limit reached.');
      progress.attempts++;
      return transport(request);
    },
  });
  const classifications = await assessJsonLicenseRows({
    artifact: input.artifact,
    eligibility,
    ...options,
    shouldStop: input.stop,
    now: dependencies.now,
    classify: async (...args) => {
      const result = await classify(...args);
      progress.completedRows++;
      return result;
    },
  });
  return { artifact: { ...input.artifact, classifications }, eligibility };
}

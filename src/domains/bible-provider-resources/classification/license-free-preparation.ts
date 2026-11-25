import { createRequestCache, llmRequestHash } from '@/lib/llm/request-cache';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseEligibilityRow } from './license-eligibility';
import type { LicenseReviewDrafts } from './license-review-drafts';

import { createLicenseClassifier } from '../license-classifier';
import { buildLicenseSampleRequest, parseLicenseVote } from '../license-model-contract';
import { isLicenseNoticeUnavailable } from '../license-normalizer';
import { matchLicenseRule } from '../license-rules';
import { assessJsonLicenseRows } from './license-analysis';
import { licenseKeyDigest } from './license-eligibility';

export interface FreeSelection {
  id: string;
  kind: 'rule' | 'model';
  confirmation?: string;
}

export async function stageFreePreparation(input: {
  completedLaunchSelections: ReadonlySet<string>;
  confirmationNonce: string;
  estimateGeneration: string;
  artifact: LicenseArtifact;
  options: LicenseCommandOptions;
  eligibility: LicenseEligibilityRow[];
  drafts: Pick<LicenseReviewDrafts, 'values' | 'epoch'>;
  contentRevision: number;
  selection?: FreeSelection;
  now?: () => string;
}) {
  const { artifact, options, drafts, selection } = input;
  const cache = options.noCache ? undefined : createRequestCache(options.cacheDir);
  const responses = new Map<string, string>();
  const eligible = new Map(input.eligibility.map((row) => [row.normalizedText, row]));
  const free: LicenseEligibilityRow[] = [];
  const completedLaunchSelections: string[] = [];
  const unmatchedRuleIds: string[] = [];
  const launchRules = new Set(options.rerunRule);
  const launchModels = new Set(options.rerunModel);
  const outstanding: Array<{
    id: string;
    human: boolean;
    replacementConfirmation?: string;
    exampleNotice?: string;
    missing: number[];
    sampleHashes: (string | null)[];
  }> = [];
  const replacements: Array<{ id: string; kind: FreeSelection['kind']; confirmation: string }> = [];
  const model = options.model.replace(/^google:/, '');
  const settings = [options.model, options.sampleCount, options.cacheDir, options.noCache];
  let found = !selection;
  let confirmed = false;
  for (const row of artifact.classifications) {
    const id = licenseKeyDigest(row.normalizedText);
    if (selection && selection.id !== id) continue;
    found = true;
    const values = drafts.values(row);
    const human = values.reviewState === 'human_reviewed' || row.source === 'manual';
    const plan = eligible.get(row.normalizedText);
    const action = selection?.kind ?? plan?.action;
    if (!action || action === 'retain') continue;
    const launchSelection = (action === 'rule' ? launchRules : launchModels).has(id);
    if (human && !selection && !launchSelection) continue;
    const launchKey = `${action}:${id}`;
    if (
      !selection &&
      (launchSelection
        ? input.completedLaunchSelections.has(launchKey)
        : row.source === 'rule' || row.reviewState === 'llm_reviewed')
    )
      continue;
    const notice = plan?.exampleNotice ?? row.exampleNotice;
    if (isLicenseNoticeUnavailable(notice)) {
      if (selection) throw new Error('An original notice is required for reassessment');
      continue;
    }
    const rule = action === 'rule' ? matchLicenseRule(notice) : null;
    if (action === 'rule' && !rule) {
      unmatchedRuleIds.push(id);
      continue;
    }
    const missing: number[] = [];
    const sampleHashes: (string | null)[] = [];
    if (action === 'model') {
      for (let index = 1; index <= options.sampleCount; index++) {
        const request = buildLicenseSampleRequest(notice, 'google', model, index);
        const response = (await cache?.read(request)) ?? null;
        if (response !== null) {
          try {
            parseLicenseVote(response);
            responses.set(llmRequestHash(request), response);
            sampleHashes.push(licenseKeyDigest(response));
            continue;
          } catch {
            // Invalid votes require a fresh sample.
          }
        }
        missing.push(index);
        sampleHashes.push(null);
      }
    }
    if (missing.length) {
      outstanding.push({
        id,
        human,
        missing,
        sampleHashes,
        ...(human && {
          exampleNotice: notice,
          replacementConfirmation: licenseKeyDigest(
            JSON.stringify([
              input.confirmationNonce,
              drafts.epoch,
              id,
              row,
              values,
              settings,
              action,
              sampleHashes,
            ])
          ),
        }),
      });
      continue;
    }
    if (human) {
      const confirmation = licenseKeyDigest(
        JSON.stringify([
          input.confirmationNonce,
          drafts.epoch,
          id,
          row,
          values,
          settings,
          action,
          rule,
          sampleHashes,
        ])
      );
      if (selection?.confirmation !== confirmation) {
        if (selection?.confirmation) throw new Error('Stale reassessment confirmation');
        replacements.push({ id, kind: action, confirmation });
        continue;
      }
      confirmed = true;
    }
    if (launchSelection) completedLaunchSelections.push(launchKey);
    free.push({
      normalizedText: row.normalizedText,
      exampleNotice: notice,
      action,
      reason: 'Free preparation',
      ruleMatches: Boolean(rule),
      savedEvidenceReuse: false,
    });
  }
  if (selection?.confirmation && !confirmed) throw new Error('Stale reassessment confirmation');
  if (!found) throw new Error('No exact normalized classification exists');
  const classifications = free.length
    ? await assessJsonLicenseRows({
        artifact,
        eligibility: free,
        classify: createLicenseClassifier({
          cachedResponses: responses,
          model: options.model,
          sampleCount: options.sampleCount,
        }),
        model: options.model,
        sampleCount: options.sampleCount,
        now: input.now,
      })
    : artifact.classifications;
  const contentRevision = input.contentRevision + Number(free.length > 0);
  const expectedUncachedRequests = outstanding.reduce((sum, row) => sum + row.missing.length, 0);
  return {
    responses,
    artifact: { ...artifact, classifications },
    free,
    completedLaunchSelections,
    estimate: {
      contentRevision,
      fingerprint: licenseKeyDigest(
        JSON.stringify([
          drafts.epoch,
          contentRevision,
          input.estimateGeneration,
          settings,
          selection?.id,
          selection?.kind,
          outstanding,
          unmatchedRuleIds,
        ])
      ),
      selection: selection ? { id: selection.id, kind: selection.kind } : null,
      cacheReadEnabled: !options.noCache,
      provider: 'google',
      model,
      sampleCount: options.sampleCount,
      outstanding,
      unmatchedRuleIds,
      replacements,
      expectedUncachedRequests,
      maximumAttempts: expectedUncachedRequests * 5,
      cost: {
        status: 'unavailable',
        reason: 'Verified model pricing and token estimates are unavailable.',
      },
    },
  };
}

import { createHash } from 'node:crypto';

import type { LicenseClassification } from '../license-artifact.schemas';

import { normalizeLicenseNotice } from '../license-normalizer';
import { matchLicenseRule } from '../license-rules';

export type LicenseEligibilityAction = 'retain' | 'rule' | 'model';

export interface LicenseEligibilityRow {
  normalizedText: string;
  exampleNotice: string;
  action: LicenseEligibilityAction;
  reason: string;
  ruleMatches: boolean;
  savedEvidenceReuse: boolean;
}

export const licenseKeyDigest = (key: string) => createHash('sha256').update(key).digest('hex');

/** Resolve user-selected digests only against keys in the inspected source. */
function resolveLicenseKeyDigests(keys: Iterable<string>, digests: readonly string[]) {
  const lookup = new Map<string, string>();
  for (const key of keys) {
    const digest = licenseKeyDigest(key);
    if (lookup.has(digest) && lookup.get(digest) !== key)
      throw new Error(`Ambiguous normalized license key digest: ${digest}`);
    lookup.set(digest, key);
  }
  const selected = new Set<string>();
  for (const digest of digests) {
    const key = lookup.get(digest);
    if (!key) throw new Error(`Selected license key digest is absent from source: ${digest}`);
    if (selected.has(key)) throw new Error(`Duplicate selected license key digest: ${digest}`);
    selected.add(key);
  }
  return selected;
}

export function planLicenseEligibility(input: {
  notices: Iterable<string>;
  stored: ReadonlyMap<string, LicenseClassification>;
  ruleDigests: readonly string[];
  modelDigests: readonly string[];
  source: 'json' | 'database';
}): LicenseEligibilityRow[] {
  const examples = new Map<string, string>();
  for (const notice of input.notices) {
    const key = normalizeLicenseNotice(notice);
    if (!examples.has(key)) examples.set(key, notice);
  }
  for (const key of input.stored.keys()) if (!examples.has(key)) examples.set(key, key);
  const ruleKeys = resolveLicenseKeyDigests(examples.keys(), input.ruleDigests);
  const modelKeys = resolveLicenseKeyDigests(examples.keys(), input.modelDigests);
  return [...examples]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([normalizedText, exampleNotice]) => {
      const prior = input.stored.get(normalizedText);
      const ruleMatches = Boolean(matchLicenseRule(exampleNotice));
      const explicitRule = ruleKeys.has(normalizedText);
      const explicitModel = modelKeys.has(normalizedText);
      if (explicitRule && prior && prior.reviewState !== 'unreviewed')
        throw new Error(`Rule reevaluation requires an unreviewed row: ${normalizedText}`);
      let action: LicenseEligibilityAction = 'retain';
      let reason = 'saved decision';
      if (explicitModel && (!explicitRule || !ruleMatches)) {
        action = 'model';
        reason = 'explicit model selection';
      } else if (explicitRule) {
        action = 'rule';
        reason = 'explicit rule selection';
      } else if (
        input.source === 'database' &&
        (!prior || (prior.reviewState === 'unreviewed' && prior.status === 'unknown'))
      ) {
        action = ruleMatches ? 'rule' : 'model';
        reason = prior ? 'unreviewed unknown database key' : 'new database key';
      } else if (!prior && input.source === 'json') {
        throw new Error(`JSON catalog key has no saved classification: ${normalizedText}`);
      }
      return {
        normalizedText,
        exampleNotice,
        action,
        reason,
        ruleMatches,
        savedEvidenceReuse: Boolean(prior?.source === 'gemini' && prior.samples.length),
      };
    });
}

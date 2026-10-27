import type { TtsLicenseStatus } from '@/domains/bibles/bibles.types';

import { effectiveLicenseStatus } from '../license-impact';

/** The sync has no rule or model dependency and never creates classification rows. */
export function deriveDblLicensePolicy(
  facts: { externalId: string; textLicenseNotice: string | null }[],
  classifications: { normalizedText: string; status: TtsLicenseStatus }[],
  current: { externalId: string; status: TtsLicenseStatus }[],
  preserveExistingNonUnknowns = false
) {
  const known = new Map(classifications.map((row) => [row.normalizedText, row.status]));
  const existing = new Map(current.map((row) => [row.externalId, row.status]));
  const statuses = new Map<string, TtsLicenseStatus>();
  const summary = {
    allowed: 0,
    forbidden: 0,
    unknown: 0,
    newlyFlagged: 0,
    missingKeys: [] as string[],
    disagreements: [] as {
      externalId: string;
      current: TtsLicenseStatus;
      derived: TtsLicenseStatus;
    }[],
  };
  const missing = new Set<string>();
  for (const fact of facts) {
    const before = existing.get(fact.externalId);
    const effective = effectiveLicenseStatus(
      fact.textLicenseNotice,
      known,
      before,
      preserveExistingNonUnknowns
    );
    statuses.set(fact.externalId, effective.status);
    summary[effective.status]++;
    if (effective.missingClassification) {
      missing.add(effective.normalizedText!);
      if (effective.status === 'unknown' && before !== 'unknown') summary.newlyFlagged++;
    }
    if (effective.disagreement)
      summary.disagreements.push({
        externalId: fact.externalId,
        current: effective.status,
        derived: effective.derivedStatus,
      });
  }
  summary.missingKeys = [...missing].sort();
  return { statuses, summary };
}

export function licenseSyncGuidance(
  unknown: number,
  missingKeys: number,
  tableEmpty = false,
  authoritativeUnknown = 0
) {
  return [
    tableEmpty
      ? 'Classification review needed: the classification table is empty; Phase-1 cached statuses are not authoritative classifications.'
      : unknown || missingKeys || authoritativeUnknown
        ? `Classification review needed: ${unknown} cached unknown resources; ${authoritativeUnknown} authoritative unknown classification rows; ${missingKeys} distinct missing normalized notice keys.`
        : 'No unknown license classifications are present; no classification run is needed',
    'No additional catalog sync is required before classification.',
    'Review/update: npm run db:classify:licenses -- --source=database --destination=json',
  ].join('\n');
}

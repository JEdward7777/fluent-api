import type { DbTransaction } from '@/lib/types';

import type { LicenseDatabaseAdapter } from './license-database.types';

import { effectiveLicenseStatus } from '../license-impact';
import * as repo from './license-classifications.repository';
import { licenseSyncGuidance } from './license-sync-policy';

export function getClassifications(tx?: DbTransaction) {
  return repo.getClassifications(tx);
}

export function createLicenseDatabaseAdapter(): LicenseDatabaseAdapter {
  return { load: repo.loadClassificationSnapshot, apply: repo.applyClassifications };
}

export async function getSyncGuidance() {
  const snapshot = await repo.loadClassificationSnapshot();
  const known = new Map(snapshot.classifications.map((row) => [row.normalizedText, row.status]));
  const rows = snapshot.context.resources.filter((row) => row.provider === 'dbl');
  const missing = new Set(
    rows
      .map((row) => effectiveLicenseStatus(row.rawNotice, known))
      .filter((row) => row.missingClassification)
      .map((row) => row.normalizedText)
  );
  return licenseSyncGuidance(
    rows.filter((row) => row.ttsLicenseStatus === 'unknown').length,
    missing.size,
    known.size === 0,
    snapshot.classifications.filter((row) => row.status === 'unknown').length
  );
}

import type { JsonValue } from '@/lib/llm/canonical-json';

import type { LicenseArtifact, LicenseClassification } from '../license-artifact.schemas';
import type { LicenseDatabaseContext } from '../license-impact';

export interface StoredLicenseClassification {
  normalizedText: string;
  status: LicenseClassification['status'];
  rationale: string;
  classifiedBy: string | null;
  reviewedAt: string | null;
  storedRationale?: JsonValue;
  evidence?: LicenseClassification;
  classificationRun?: LicenseArtifact['classificationRun'];
}
export interface LicenseDatabaseSnapshot {
  tableExists: boolean;
  classifications: StoredLicenseClassification[];
  context: LicenseDatabaseContext;
}
export interface LicenseDatabaseAdapter {
  load: () => Promise<LicenseDatabaseSnapshot>;
  apply: (
    artifact: LicenseArtifact,
    replace: boolean,
    beforeCommit?: () => Promise<void>,
    force?: boolean
  ) => Promise<void>;
  close?: () => Promise<void>;
}

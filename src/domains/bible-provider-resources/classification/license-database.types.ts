import type { JsonValue } from '@/lib/llm/canonical-json';

import type { LicenseArtifact, LicenseClassification } from '../license-artifact.schemas';
import type { LicenseDatabaseContext } from '../license-impact';
import type {
  ChallengeConnection,
  DatabaseProof,
  LicenseRelation,
} from './license-database-identity';

export interface StoredLicenseClassification {
  normalizedText: string;
  /** A matching raw notice from the currently loaded catalog, when available. */
  exampleNotice?: string;
  status: LicenseClassification['status'];
  rationale: string;
  classifiedBy: string | null;
  reviewedAt: string | null;
  reviewState?: LicenseClassification['reviewState'];
  decisionAt?: string | null;
  reviewedBy?: string | null;
  humanReviewedAt?: string | null;
  storedRationale?: JsonValue;
  evidence?: LicenseClassification;
  classificationRun?: LicenseArtifact['classificationRun'];
}
export interface LicenseDatabaseSnapshot {
  sourceMarker?: string;
  relation?: LicenseRelation | null;
  tableExists: boolean;
  classifications: StoredLicenseClassification[];
  context: LicenseDatabaseContext;
}
export interface LicenseDatabaseAdapter {
  inspectTarget?: (challenge?: ChallengeConnection) => Promise<{
    snapshot: LicenseDatabaseSnapshot;
    marker: string;
    proof?: DatabaseProof;
  }>;
  loadSource?: () => Promise<LicenseDatabaseSnapshot>;
  challenge?: (sourceMarker?: string) => ChallengeConnection;
  prove?: (challenge?: ChallengeConnection) => Promise<DatabaseProof>;
  load: (role?: 'source') => Promise<LicenseDatabaseSnapshot>;
  apply: (
    artifact: LicenseArtifact,
    replace: boolean,
    beforeCommit?: () => Promise<void>,
    force?: boolean,
    expectedPolicy?: StoredLicenseClassification[],
    identity?: {
      marker?: string;
      expected?: DatabaseProof;
      target?: LicenseRelation | null;
      challenge?: ChallengeConnection;
    }
  ) => Promise<void>;
  close?: () => Promise<void>;
}

export class LicensePolicyDriftError extends Error {
  constructor(
    message = 'License classification policy changed since preview; inspect and preview again'
  ) {
    super(message);
    this.name = 'LicensePolicyDriftError';
  }
}

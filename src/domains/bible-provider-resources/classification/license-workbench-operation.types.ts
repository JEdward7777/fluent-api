import type { LicenseReconciliation, LicenseWriteRecovery } from './license-write';

export interface VisibleOperation {
  operationId: string;
  kind: 'inspect' | 'analysis' | 'paid' | 'save';
  state: 'running' | 'succeeded' | 'failed';
  configurationRevision?: number;
  contentRevision?: number;
  error?: string;
  progress?: {
    attempts: number;
    completedRows: number;
    totalRows: number;
    stopRequested?: boolean;
  };
  cleanupWarning?: string;
  reconciliation?: LicenseReconciliation;
  recovery?: LicenseWriteRecovery;
  result?: {
    wholeFileHash: string;
    targets: Array<{ path: string; role: 'output' | 'signed-source'; hash: string }>;
    json?: {
      inserted: number;
      updated: number;
      metadataChanges: number;
      permissionChanges: number;
      preserved: number;
      unchanged: number;
      deleted: string[];
      deletedCatalog: Array<{ provider: string; externalId: string }>;
    };
    policy: {
      inserts: number;
      updates: number;
      deletes: number;
      preserved: number;
      reviewContentHash?: string;
    } | null;
    incomplete: boolean;
  };
}
export interface RecordedOperation {
  fingerprint: string;
  snapshot: VisibleOperation;
}

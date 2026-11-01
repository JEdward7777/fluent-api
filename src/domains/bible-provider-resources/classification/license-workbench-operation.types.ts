import type { LicenseWriteRecovery } from './license-write';

export interface VisibleOperation {
  operationId: string;
  kind: 'inspect' | 'analysis' | 'save';
  state: 'running' | 'succeeded' | 'failed';
  configurationRevision?: number;
  contentRevision?: number;
  error?: string;
  recovery?: LicenseWriteRecovery;
  result?: {
    wholeFileHash: string;
    targets: Array<{ path: string; role: 'output' | 'signed-source'; hash: string }>;
    policy: { inserts: number; updates: number; deletes: number } | null;
    incomplete: boolean;
  };
}
export interface RecordedOperation {
  fingerprint: string;
  snapshot: VisibleOperation;
}

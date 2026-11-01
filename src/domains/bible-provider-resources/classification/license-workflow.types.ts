import type { LlmTransport } from '@/lib/llm/structured-request';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseDatabaseAdapter, LicenseDatabaseSnapshot } from './license-database.types';
import type { LicensePreflight } from './license-preflight';
import type { LicenseSavePlan } from './license-save-plan';
import type { LicenseFileIo } from './license-write';

export type LicenseWorkflowState =
  | 'configuring'
  | 'reconfiguring'
  | 'inspecting'
  | 'inspected'
  | 'analyzing'
  | 'reviewing'
  | 'previewing'
  | 'previewed'
  | 'saving'
  | 'exporting'
  | 'saved'
  | 'uncertain'
  | 'error'
  | 'closed';

export interface LicenseInspection {
  configurationRevision: number;
  inspectedAt: string;
  inputBytes: string | null;
  outputBytes: string | null;
  database?: LicenseDatabaseSnapshot;
  preflight: LicensePreflight;
}

export interface LicenseAnalysis {
  configurationRevision: number;
  contentRevision: number;
  artifact: LicenseArtifact;
  originalSourceArtifact?: LicenseArtifact;
}

export type LicenseReviewEdit =
  | {
      kind: 'disposition';
      normalizedText: string;
      status: LicenseArtifact['classifications'][number]['status'];
      reason: string;
    }
  | { kind: 'unknown-note'; normalizedText: string; note: string };

export interface LicensePreview {
  configurationRevision: number;
  contentRevision: number;
  plan: LicenseSavePlan;
  reports: LicenseSavePlan['reports'];
}

export interface LicenseSaveRequest {
  operationId: string;
  configurationRevision: number;
  contentRevision: number;
  agreeToReplace: boolean;
}

export interface LicenseReadOperationRequest {
  operationId: string;
  configurationRevision: number;
}

export interface LicenseReportExportRequest {
  operationId: string;
  configurationRevision: number;
  contentRevision: number;
  format: 'html' | 'markdown';
  path: string;
  expectedPreviousBytes: string | null;
  agreeToOverwrite: boolean;
}

export interface LicenseReportExportResult {
  operationId: string;
  configurationRevision: number;
  contentRevision: number;
  path: string;
  format: LicenseReportExportRequest['format'];
}

export interface LicenseSaveResult {
  configurationRevision: number;
  contentRevision: number;
  operationId: string;
  wholeFileHash: string;
  targets: LicenseSavePlan['targets'];
}

export interface LicenseSaveOperation {
  fingerprint: string;
  promise: Promise<LicenseSaveResult>;
}

export interface LicenseWorkflowDependencies {
  apiKey: string;
  fs?: LicenseFileIo;
  database?: () => Promise<LicenseDatabaseAdapter>;
  transport?: LlmTransport;
  now?: () => string;
  /** The legacy terminal command preserves its existing snapshot behavior. */
  legacySkipFreshness?: boolean;
}

import type { z } from 'zod';

import { config as loadDotenv } from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';

import type { LicenseCommandOptions } from './license-command-options';
import type { StoredLicenseClassification } from './license-database.types';
import type { LicensePractice } from './license-practice';
import type { RecordedOperation, VisibleOperation } from './license-workbench-operation.types';
import type { LicenseReviewQuery } from './license-workbench-review';
import type { operationSchema, setupSchema } from './license-workbench-schema';
import type { LicenseInspection, LicenseReviewEdit } from './license-workflow.types';

import { createLicensePractice } from './license-practice';
import { licenseWorkbenchBrowserError } from './license-workbench-error';
import { licenseWorkbenchPreviewView } from './license-workbench-preview-view';
import { LicenseWorkbenchReports } from './license-workbench-reports';
import {
  licenseWorkbenchReviewDetail,
  licenseWorkbenchReviewList,
} from './license-workbench-review-view';
import { LicenseWorkflow } from './license-workflow';
import { LicenseWriteUncertainError } from './license-write';

export class LicenseWorkbenchSession {
  private options: LicenseCommandOptions;
  private readonly launchId = randomUUID();
  private workflow?: LicenseWorkflow;
  private configurationRevision = 1;
  private inspected?: Pick<LicenseInspection, 'inspectedAt' | 'preflight'>;
  private sourceHash?: string;
  private policyBaseline?: StoredLicenseClassification[];
  private databaseTarget = 'Configured environment database; identity checked at Inspect';
  private readonly operations = new Map<string, RecordedOperation>();
  private activeOperationId?: string;
  private latestOperationId?: string;
  private latestSaveOperationId?: string;
  private practice?: LicensePractice;
  private readonly practiceMode: boolean;
  private selectedPracticePath: string | null;
  private readonly reports = new LicenseWorkbenchReports();

  constructor(options: LicenseCommandOptions, practiceMode = false) {
    this.options = { ...options };
    this.practiceMode = practiceMode;
    this.selectedPracticePath = practiceMode && options.input !== '' ? options.input : null;
    if (practiceMode)
      this.options = {
        ...options,
        source: 'json',
        destination: 'json',
        force: false,
        noCache: false,
        cacheDir: undefined,
        reportDir: undefined,
        reportFormats: 'none',
        preserveExistingNonUnknowns: false,
      };
    if (practiceMode)
      this.databaseTarget = 'Offline practice: no database connection or provider requests';
  }

  get visible() {
    const status = this.workflow?.status;
    const { options } = this;
    const inspected =
      status && !['configuring', 'error', 'closed'].includes(status.state)
        ? this.inspected
        : undefined;
    const preview = licenseWorkbenchPreviewView({
      workflow: this.workflow,
      options,
      configurationRevision: this.configurationRevision,
      policyBaseline: this.policyBaseline,
      practiceMode: this.practiceMode,
    });
    return {
      step: 'Choose inputs',
      launchId: this.launchId,
      practice: this.practiceMode,
      scratch: this.practice?.scratch ?? null,
      originalHash: this.practice?.originalHash ?? null,
      selectedSource: this.selectedPracticePath,
      state: status?.state ?? 'configuring',
      configurationRevision: this.configurationRevision,
      contentRevision: status?.contentRevision ?? 0,
      readyForInspect: Boolean(options.source && options.destination),
      source: options.source ?? null,
      destination: options.destination ?? null,
      input: this.practiceMode ? (this.selectedPracticePath ?? 'Bundled example') : options.input,
      output: this.practiceMode
        ? (this.practice?.options.output ?? 'Allocated after Inspect')
        : options.output,
      sampleCount: options.sampleCount,
      model: options.model,
      force: options.force,
      noCache: options.noCache,
      cacheDir: options.cacheDir ?? null,
      reportFormats: options.reportFormats,
      reportDir: options.reportDir ?? null,
      preserveExistingNonUnknowns: options.preserveExistingNonUnknowns,
      databaseTarget: this.databaseTarget,
      inspected: inspected
        ? {
            inspectedAt: inspected.inspectedAt,
            sourceHash: this.sourceHash ?? null,
            preflight: {
              source: inspected.preflight.source,
              distinctKeys: inspected.preflight.distinctKeys,
              tableHits: inspected.preflight.tableHits,
              ruleHits: inspected.preflight.ruleHits,
              modelKeys: inspected.preflight.modelKeys,
              validCacheHits: inspected.preflight.validCacheHits,
              expectedUncachedRequests: inspected.preflight.expectedUncachedRequests,
              maximumAttempts: inspected.preflight.maximumAttempts,
              cost: inspected.preflight.cost,
            },
          }
        : null,
      analysis: this.workflow?.analyzed
        ? {
            rows: this.workflow.analyzed.artifact.classifications.length,
            contentRevision: this.workflow.analyzed.contentRevision,
          }
        : null,
      preview,
      saveOutcome: this.latestSaveOperationId ? this.operation(this.latestSaveOperationId) : null,
      activeOperationId: this.activeOperationId ?? null,
      latestOperation: this.latestOperationId ? this.operation(this.latestOperationId) : null,
    };
  }

  operation(id: string) {
    return structuredClone(this.operations.get(id)?.snapshot ?? null);
  }

  listReview(query: LicenseReviewQuery) {
    return licenseWorkbenchReviewList(
      this.workflow,
      this.configurationRevision,
      this.options,
      query
    );
  }

  reviewDetail(id: string) {
    return licenseWorkbenchReviewDetail(
      this.workflow,
      this.configurationRevision,
      this.options,
      id
    );
  }

  async configure(body: z.infer<typeof setupSchema>) {
    if (body.configurationRevision !== this.visible.configurationRevision)
      throw new Error('Configuration changed; reload setup before applying');
    if (this.activeOperationId) throw new Error('Cannot configure while an operation runs');
    if (this.practiceMode) {
      if (
        this.activeOperationId ||
        (this.workflow &&
          [
            'inspecting',
            'analyzing',
            'previewing',
            'saving',
            'exporting',
            'reconfiguring',
          ].includes(this.workflow.status.state))
      )
        throw new Error('Cannot configure while an operation runs');
      if (this.workflow?.status.state === 'uncertain')
        throw new Error('Save outcome uncertain; inspect scratch targets before restarting');
      if (
        body.source !== 'json' ||
        body.destination !== 'json' ||
        body.output !== this.visible.output ||
        body.force ||
        body.noCache ||
        body.cacheDir !== this.visible.cacheDir ||
        body.reportDir !== this.visible.reportDir ||
        body.reportFormats !== this.visible.reportFormats ||
        body.model !== this.visible.model ||
        body.sampleCount !== this.visible.sampleCount ||
        body.preserveExistingNonUnknowns
      )
        throw new Error('Practice setup only permits selecting a saved JSON input');
      if (this.workflow?.analyzed && !body.discardReviewedState)
        throw new Error('Explicit discard is required before changing reviewed unsaved state');
      await this.workflow?.close();
      this.workflow = undefined;
      this.practice = undefined;
      this.selectedPracticePath = body.input === 'Bundled example' ? null : body.input.trim();
      this.configurationRevision++;
      this.inspected = undefined;
      this.sourceHash = undefined;
      this.policyBaseline = undefined;
      this.reports.clear();
      this.latestOperationId = undefined;
      this.latestSaveOperationId = undefined;
      return this.visible;
    }
    const options: LicenseCommandOptions = {
      ...this.options,
      source: body.source ?? undefined,
      destination: body.destination ?? undefined,
      input: body.input,
      output: body.output,
      model: body.model,
      sampleCount: body.sampleCount,
      force: body.force,
      noCache: body.noCache,
      cacheDir: body.cacheDir ?? undefined,
      reportFormats: body.reportFormats,
      reportDir: body.reportDir ?? undefined,
      preserveExistingNonUnknowns: body.preserveExistingNonUnknowns,
    };
    if (this.workflow) {
      await this.workflow.configure(
        options,
        this.workflow.status.configurationRevision,
        body.discardReviewedState
      );
    }
    this.configurationRevision++;
    this.reports.clear();
    this.options = options;
    this.inspected = undefined;
    this.sourceHash = undefined;
    this.policyBaseline = undefined;
    this.latestOperationId = undefined;
    this.latestSaveOperationId = undefined;
    this.databaseTarget = 'Configured environment database; identity checked at Inspect';
    return this.visible;
  }

  start(kind: VisibleOperation['kind'], body: z.infer<typeof operationSchema>) {
    const fingerprint = JSON.stringify([kind, body.configurationRevision]);
    const prior = this.operations.get(body.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error('Operation ID was reused with different arguments');
      return { ...prior.snapshot };
    }
    if (this.activeOperationId) throw new Error('Another operation is running');
    if (this.workflow?.status.state === 'uncertain')
      throw new Error('Save outcome uncertain; inspect actual targets in a new process');
    if (body.configurationRevision !== this.visible.configurationRevision)
      throw new Error('Configuration changed; reload setup before continuing');
    if (!this.options.source || !this.options.destination)
      throw new Error('Choose both source and destination');
    if (kind === 'inspect' && !this.workflow && !this.practiceMode) {
      loadDotenv({ quiet: true });
      this.workflow = new LicenseWorkflow(this.options, {
        apiKey: process.env.GEMINI_API_KEY ?? '',
      });
    }
    if (!this.workflow && kind !== 'inspect')
      throw new Error('Inspect inputs before starting analysis');
    const operation: VisibleOperation = { operationId: body.operationId, kind, state: 'running' };
    this.operations.set(body.operationId, { fingerprint, snapshot: operation });
    this.activeOperationId = body.operationId;
    this.latestOperationId = body.operationId;
    const promise = (async () => {
      if (kind === 'inspect' && this.practiceMode && !this.workflow) {
        this.practice = await createLicensePractice(this.selectedPracticePath);
        this.workflow = this.practice.workflow;
        this.options = this.practice.options;
      }
      if (!this.workflow) throw new Error('Inspect inputs before starting analysis');
      const coreRequest = {
        ...body,
        configurationRevision: this.workflow.status.configurationRevision,
      };
      return kind === 'inspect'
        ? this.workflow.inspect(coreRequest)
        : this.workflow.startAnalysis(coreRequest);
    })();
    void promise.then(
      (result) => {
        if (kind === 'inspect' && 'preflight' in result)
          this.inspected = { inspectedAt: result.inspectedAt, preflight: result.preflight };
        if (kind === 'inspect' && 'inputBytes' in result)
          this.sourceHash =
            result.inputBytes === null
              ? undefined
              : createHash('sha256').update(result.inputBytes).digest('hex');
        if (kind === 'inspect' && 'database' in result)
          this.policyBaseline = result.database?.classifications;
        if (
          kind === 'inspect' &&
          (this.options.source === 'database' || this.options.destination !== 'json')
        ) {
          const raw = process.env.DATABASE_URL;
          if (raw) {
            try {
              const url = new URL(raw);
              this.databaseTarget = `Configured database: ${url.hostname}:${url.port || 'default'}/${decodeURIComponent(url.pathname.replace(/^\//, ''))}`;
            } catch {
              this.databaseTarget = 'Configured environment database';
            }
          }
        }
        operation.state = 'succeeded';
        this.activeOperationId = undefined;
      },
      (error: unknown) => {
        operation.state = 'failed';
        operation.error = licenseWorkbenchBrowserError(error);
        this.activeOperationId = undefined;
      }
    );
    return { ...operation };
  }

  stop() {
    if (!this.workflow) throw new Error('No analysis is running');
    return this.workflow.requestStopAnalysis();
  }

  editReview(body: {
    configurationRevision: number;
    contentRevision: number;
    id: string;
    edit: LicenseReviewEdit;
    acknowledgeWarning: boolean;
  }) {
    if (this.activeOperationId) throw new Error('An operation is running; wait before editing');
    if (!this.workflow) throw new Error('Start analysis before editing evidence');
    if (body.configurationRevision !== this.configurationRevision)
      throw new Error('Stale configuration revision');
    const detail = this.reviewDetail(body.id);
    if (detail.normalizedText !== body.edit.normalizedText)
      throw new Error('Row ID does not match the exact normalized key');
    if (
      body.edit.kind === 'disposition' &&
      detail.overrideWarnings[body.edit.status] &&
      !body.acknowledgeWarning
    )
      throw new Error('Acknowledge the automatic-decision warning before applying this override');
    return this.workflow.editReview(
      body.edit,
      this.workflow.status.configurationRevision,
      body.contentRevision
    );
  }

  async previewPractice(configurationRevision: number, contentRevision: number) {
    return this.preview(configurationRevision, contentRevision, true);
  }

  async preview(configurationRevision: number, contentRevision: number, practice = false) {
    if (this.practiceMode !== practice || !this.workflow)
      throw new Error('Preview is unavailable in this mode');
    if (this.activeOperationId) throw new Error('An operation is running');
    if (configurationRevision !== this.configurationRevision)
      throw new Error('Stale configuration revision');
    return this.workflow.preview(this.workflow.status.configurationRevision, contentRevision);
  }

  attest(body: {
    configurationRevision: number;
    contentRevision: number;
    reviewContentHash: string;
    reviewedBy: string;
    reviewReason: string;
    responsibility: true;
  }) {
    if (this.practiceMode || !this.workflow) throw new Error('Attestation is unavailable');
    if (this.activeOperationId) throw new Error('An operation is running');
    if (body.configurationRevision !== this.configurationRevision)
      throw new Error('Stale configuration revision');
    return this.workflow.attest(
      {
        reviewedBy: body.reviewedBy,
        reviewReason: body.reviewReason,
        reviewedAt: new Date().toISOString(),
      },
      this.workflow.status.configurationRevision,
      body.contentRevision,
      body.reviewContentHash
    );
  }

  async inspectReport(body: {
    configurationRevision: number;
    contentRevision: number;
    format: 'html' | 'markdown';
    path: string;
  }) {
    if (this.practiceMode || !this.workflow)
      throw new Error('Practice cannot inspect report targets');
    if (this.activeOperationId) throw new Error('An operation is running');
    if (this.workflow.status.state === 'uncertain')
      throw new Error('Save outcome uncertain; inspect actual targets in a new process');
    return this.reports.inspect(this.workflow, this.configurationRevision, body);
  }

  exportReport(body: { planId: string; operationId: string; agreeToOverwrite: boolean }) {
    if (this.practiceMode || !this.workflow) throw new Error('Practice cannot export reports');
    if (this.activeOperationId) throw new Error('An operation is running');
    if (this.workflow.status.state === 'uncertain')
      throw new Error('Save outcome uncertain; inspect actual targets in a new process');
    return this.reports.export(this.workflow, this.configurationRevision, body);
  }

  async savePractice(body: {
    operationId: string;
    configurationRevision: number;
    contentRevision: number;
  }) {
    if (!this.practiceMode || !this.workflow) throw new Error('Practice save is unavailable');
    return this.save({ ...body, agreeToReplace: false });
  }

  save(body: {
    operationId: string;
    configurationRevision: number;
    contentRevision: number;
    agreeToReplace: boolean;
  }) {
    const fingerprint = JSON.stringify([
      'save',
      body.configurationRevision,
      body.contentRevision,
      body.agreeToReplace,
    ]);
    const prior = this.operations.get(body.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error('Operation ID was reused with different arguments');
      return { ...prior.snapshot };
    }
    if (this.activeOperationId) throw new Error('Another operation is running');
    if (!this.workflow) throw new Error('Preview before saving');
    if (body.configurationRevision !== this.configurationRevision)
      throw new Error('Stale configuration revision');
    if (this.practiceMode && body.agreeToReplace)
      throw new Error('Practice cannot replace database policy');
    const preview = this.workflow.previewed;
    if (!preview || preview.contentRevision !== body.contentRevision)
      throw new Error('Preview this exact revision before saving');
    const policy = this.visible.preview?.policy;
    const incomplete = Boolean(this.visible.preview?.incomplete);
    const promise = this.workflow.save({
      ...body,
      configurationRevision: this.workflow.status.configurationRevision,
    });
    const operation: VisibleOperation = {
      operationId: body.operationId,
      kind: 'save',
      state: 'running',
      configurationRevision: body.configurationRevision,
      contentRevision: body.contentRevision,
    };
    this.operations.set(body.operationId, { fingerprint, snapshot: operation });
    this.activeOperationId = body.operationId;
    this.latestOperationId = body.operationId;
    this.latestSaveOperationId = body.operationId;
    void promise.then(
      (result) => {
        operation.state = 'succeeded';
        operation.result = {
          wholeFileHash: result.wholeFileHash,
          targets: result.targets.map((target) => ({
            path: target.path,
            role: target.role,
            hash: result.wholeFileHash,
          })),
          policy: policy
            ? {
                inserts: policy.inserts.length,
                updates: policy.updates.length,
                deletes: policy.deletes.length,
              }
            : null,
          incomplete,
        };
        this.activeOperationId = undefined;
      },
      (error: unknown) => {
        operation.state = 'failed';
        operation.error = licenseWorkbenchBrowserError(error);
        if (error instanceof LicenseWriteUncertainError) operation.recovery = error.recovery;
        this.activeOperationId = undefined;
      }
    );
    return { ...operation };
  }

  close() {
    return this.workflow?.close();
  }
}

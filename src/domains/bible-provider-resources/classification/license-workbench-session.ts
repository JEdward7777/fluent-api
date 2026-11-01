import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import type { LicenseCommandOptions } from './license-command-options';
import type { LicensePractice } from './license-practice';
import type { LicenseReviewQuery } from './license-workbench-review';
import type { LicenseInspection, LicenseReviewEdit } from './license-workflow.types';

import { createLicensePractice } from './license-practice';
import {
  getLicenseWorkbenchReviewDetail,
  listLicenseWorkbenchReview,
} from './license-workbench-review';
import { LicenseWorkflow } from './license-workflow';

const path = z.string().trim().min(1);
export const setupSchema = z
  .object({
    configurationRevision: z.number().int().positive(),
    discardReviewedState: z.boolean(),
    source: z.enum(['json', 'database']).nullable(),
    destination: z.enum(['json', 'database', 'both']).nullable(),
    input: path,
    output: path,
    model: z.string().regex(/^google:[^\s:]+$/),
    sampleCount: z.number().int().min(2),
    force: z.boolean(),
    noCache: z.boolean(),
    cacheDir: path.nullable(),
    reportFormats: z.enum(['none', 'markdown', 'html', 'markdown,html']),
    reportDir: path.nullable(),
    preserveExistingNonUnknowns: z.boolean(),
  })
  .strict();
export const operationSchema = z
  .object({
    operationId: z.string().uuid(),
    configurationRevision: z.number().int().positive(),
  })
  .strict();

interface VisibleOperation {
  operationId: string;
  kind: 'inspect' | 'analysis';
  state: 'running' | 'succeeded' | 'failed';
  error?: string;
}
interface RecordedOperation {
  fingerprint: string;
  snapshot: VisibleOperation;
}

function browserError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('GEMINI_API_KEY'))
    return 'A nonempty GEMINI_API_KEY is required before reading any source';
  if (message.includes('Inspect inputs before')) return message;
  if (message.includes('Stale license')) return 'Inputs changed; inspect again before continuing';
  if (message.includes('not found'))
    return 'Selected JSON source was not found; check its path and inspect again';
  return 'Operation failed. Check selected inputs and server configuration, then try again.';
}

export class LicenseWorkbenchSession {
  private options: LicenseCommandOptions;
  private workflow?: LicenseWorkflow;
  private configurationRevision = 1;
  private inspected?: Pick<LicenseInspection, 'inspectedAt' | 'preflight'>;
  private databaseTarget = 'Configured environment database; identity checked at Inspect';
  private readonly operations = new Map<string, RecordedOperation>();
  private activeOperationId?: string;
  private latestOperationId?: string;
  private practice?: LicensePractice;
  private readonly practiceMode: boolean;
  private selectedPracticePath: string | null;

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
    const { options, inspected } = this;
    return {
      step: 'Choose inputs',
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
      preview:
        this.practiceMode && this.workflow?.previewed
          ? {
              contentRevision: this.workflow.previewed.contentRevision,
              wholeFileHash: this.workflow.previewed.plan.wholeFileHash,
              output: this.workflow.previewed.plan.targets[0]?.path,
            }
          : null,
      activeOperationId: this.activeOperationId ?? null,
      latestOperation: this.latestOperationId ? this.operation(this.latestOperationId) : null,
    };
  }

  operation(id: string) {
    const operation = this.operations.get(id);
    return operation ? { ...operation.snapshot } : null;
  }

  listReview(query: LicenseReviewQuery) {
    const analysis = this.workflow?.analyzed;
    if (!analysis) throw new Error('Start analysis before reviewing evidence');
    return {
      configurationRevision: this.configurationRevision,
      contentRevision: analysis.contentRevision,
      ...listLicenseWorkbenchReview(
        analysis.artifact,
        query,
        this.workflow?.reviewDatabaseContext,
        this.options.preserveExistingNonUnknowns
      ),
    };
  }

  reviewDetail(id: string) {
    const analysis = this.workflow?.analyzed;
    if (!analysis) throw new Error('Start analysis before reviewing evidence');
    const detail = getLicenseWorkbenchReviewDetail(
      analysis.artifact,
      id,
      this.workflow?.reviewDatabaseContext,
      this.options.preserveExistingNonUnknowns
    );
    if (!detail) throw new Error('Review row was not found');
    return {
      ...detail,
      configurationRevision: this.configurationRevision,
      contentRevision: analysis.contentRevision,
    };
  }

  async configure(body: z.infer<typeof setupSchema>) {
    if (body.configurationRevision !== this.visible.configurationRevision)
      throw new Error('Configuration changed; reload setup before applying');
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
      this.latestOperationId = undefined;
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
    this.options = options;
    this.inspected = undefined;
    this.latestOperationId = undefined;
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
        operation.error = browserError(error);
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
    if (!this.practiceMode || !this.workflow) throw new Error('Practice preview is unavailable');
    if (configurationRevision !== this.configurationRevision)
      throw new Error('Stale configuration revision');
    return this.workflow.preview(this.workflow.status.configurationRevision, contentRevision);
  }

  async savePractice(body: {
    operationId: string;
    configurationRevision: number;
    contentRevision: number;
  }) {
    if (!this.practiceMode || !this.workflow) throw new Error('Practice save is unavailable');
    if (body.configurationRevision !== this.configurationRevision)
      throw new Error('Stale configuration revision');
    return this.workflow.save({
      ...body,
      configurationRevision: this.workflow.status.configurationRevision,
      agreeToReplace: false,
    });
  }

  async close() {
    await this.workflow?.close();
  }
}

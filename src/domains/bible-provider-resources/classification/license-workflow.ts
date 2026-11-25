import { randomUUID } from 'node:crypto';

import type { LicenseCommandOptions } from './license-command-options';
import type {
  LicenseAnalysis,
  LicenseInspection,
  LicensePreview,
  LicenseReadOperationRequest,
  LicenseReportExportRequest,
  LicenseReportExportResult,
  LicenseSaveOperation,
  LicenseSaveRequest,
  LicenseSaveResult,
  LicenseWorkflowDependencies,
} from './license-workflow.types';

import { freezeReviewValue } from '../license-review-revision';
import { LicenseAnalysisStoppedError } from './license-analysis';
import { LicensePolicyDriftError } from './license-database.types';
import { LicenseDestinationRecheckError, LicenseInspectionStaleError } from './license-freshness';
import { LicenseSourceReconciliation } from './license-source-reconciliation';
import { analyzeInspectedLicenses } from './license-workflow-analyze';
import {
  inspectLicenseWorkflowInputs,
  loadedLicenseReview,
  requirePracticeOptions,
} from './license-workflow-inspect';
import { LicenseOperationRegistry } from './license-workflow-operations';
import {
  exportPreviewedLicenseReport,
  requireSavedReportTargets,
} from './license-workflow-report-export';
import {
  compensatedLicenseInspection,
  confirmedLicenseSave,
  destinationSaveFailure,
  licenseSaveFingerprint,
  LicenseSavePreflightError,
  writePreviewedLicenseSave,
} from './license-workflow-save';
import {
  LicenseFileDriftError,
  LicenseWritePreflightError,
  LicenseWriteUncertainError,
} from './license-write';

export type { LicenseReviewEdit } from './license-workflow.types';

export class LicenseWorkflow extends LicenseSourceReconciliation {
  protected options: LicenseCommandOptions;
  protected inspection?: LicenseInspection;
  private previewReviewer = '';
  private previewPromise?: Promise<LicensePreview>;
  private closePromise?: Promise<void>;
  private uncertainSave?: {
    request: LicenseSaveRequest;
    preview: LicensePreview;
    error: LicenseWriteUncertainError;
    capture: Partial<LicenseInspection>;
  };
  private readonly saveOperations = new Map<string, LicenseSaveOperation>();
  private readonly operations = new LicenseOperationRegistry();
  constructor(options: LicenseCommandOptions, dependencies: LicenseWorkflowDependencies) {
    super(dependencies);
    this.options = freezeReviewValue(options);
  }

  get reviewDatabaseContext() {
    return this.inspection?.database?.context;
  }
  get previewed() {
    return this.previewResult;
  }
  get databaseAdapter() {
    return this.database;
  }
  operation(operationId: string) {
    return this.operations.get(operationId);
  }

  requestStopAnalysis() {
    if (this.state !== 'analyzing') throw new Error('No analysis is running');
    this.stopAnalysisRequested = true;
    return this.status;
  }

  async configure(
    options: LicenseCommandOptions,
    expectedRevision: number,
    discardReviewedState = false
  ) {
    if (this.dependencies.practice) requirePracticeOptions(options, this.dependencies.practice);
    this.requireRevision(expectedRevision);
    if (this.busyDone) throw new Error(`Cannot configure while ${this.state}`);
    if (this.state === 'uncertain')
      throw new Error('Save outcome uncertain; check the actual Save targets before continuing');
    if (this.analysis && this.state !== 'saved' && !discardReviewedState)
      throw new Error('Explicit discard is required before changing reviewed unsaved state');
    this.state = 'reconfiguring';
    this.beginBusy();
    try {
      await this.destination.closePools(this.database);
      this.database = undefined;
      this.options = freezeReviewValue(options);
      this.sourceDrift = false;
      this.proposal = undefined;
      this.inspection = undefined;
      this.analysis = undefined;
      this.previewResult = undefined;
      this.configurationRevision++;
      this.contentRevision = 0;
      this.invalidatePaidEstimate();
      this.completedLaunchSelections.clear();
      this.resetDrafts();
      this.state = 'configuring';
      return this.status;
    } catch (error) {
      this.state = 'error';
      throw error;
    } finally {
      this.endBusy();
    }
  }

  inspect(request: number | LicenseReadOperationRequest): Promise<LicenseInspection> {
    if (typeof request === 'number') return this.inspectOnce(request);
    const frozen = freezeReviewValue(request);
    return this.operations.run(frozen.operationId, 'inspect', [frozen.configurationRevision], () =>
      this.inspectOnce(frozen.configurationRevision)
    );
  }

  private async inspectOnce(expectedRevision: number): Promise<LicenseInspection> {
    this.requireRevision(expectedRevision);
    if (this.state !== 'configuring' && this.state !== 'error')
      throw new Error(`Cannot inspect while ${this.state}`);
    this.state = 'inspecting';
    this.beginBusy();
    try {
      const result = await inspectLicenseWorkflowInputs({
        options: this.options,
        dependencies: this.dependencies,
        database: this.database,
        onDatabase: (database) => {
          this.database = database;
        },
        configurationRevision: this.configurationRevision,
      });
      this.database = result.database;
      this.inspection = result.inspection;
      if (this.inspection.sourceOnly) {
        this.analysis = await loadedLicenseReview(
          this.inspection,
          this.options,
          ++this.contentRevision
        );
      }
      if (this.inspection.sourceOnly) await this.prepareLoadedFree();
      if (this.state === 'inspecting') this.state = 'inspected';
      return this.inspection;
    } catch (error) {
      this.inspection = undefined;
      this.analysis = undefined;
      this.state = 'error';
      throw error;
    } finally {
      this.endBusy();
    }
  }

  startAnalysis(request: number | LicenseReadOperationRequest): Promise<LicenseAnalysis> {
    if (typeof request === 'number') return this.analyzeOnce(request);
    const frozen = freezeReviewValue(request);
    return this.operations.run(frozen.operationId, 'analysis', [frozen.configurationRevision], () =>
      this.analyzeOnce(frozen.configurationRevision)
    );
  }

  private async analyzeOnce(expectedRevision: number): Promise<LicenseAnalysis> {
    this.requireRevision(expectedRevision);
    if (this.inspection?.sourceOnly) {
      await this.prepareFree(this.contentRevision);
      if (this.state === 'inspected') this.state = 'reviewing';
      return this.analysis!;
    }
    if (this.reviewDrafts.size)
      throw new Error('Revert pending session edits before using this operation');
    if (this.state !== 'inspected' || !this.inspection)
      throw new Error('Inspect inputs before starting analysis');
    const inspection = this.inspection;
    const options = this.options;
    this.state = 'analyzing';
    this.stopAnalysisRequested = false;
    this.beginBusy();
    try {
      const frozen = await analyzeInspectedLicenses({
        inspection,
        options,
        dependencies: this.dependencies,
        database: this.database,
        shouldStop: () => this.stopAnalysisRequested || this.closing,
      });
      this.analysis = freezeReviewValue({
        configurationRevision: this.configurationRevision,
        contentRevision: ++this.contentRevision,
        artifact: frozen,
        ...(options.source === 'json' ? { originalSourceArtifact: frozen } : {}),
      });
      this.state = 'reviewing';
      return this.analysis;
    } catch (error) {
      if (error instanceof LicenseAnalysisStoppedError) {
        this.state = 'inspected';
      } else if (error instanceof LicenseInspectionStaleError) {
        this.inspection = undefined;
        this.state = 'configuring';
      } else this.state = 'error';
      throw error;
    } finally {
      this.endBusy();
    }
  }

  async preview(
    expectedConfigurationRevision: number,
    expectedContentRevision: number,
    reviewedBy = ''
  ): Promise<LicensePreview> {
    this.requireContentRevision(expectedConfigurationRevision, expectedContentRevision);
    if (this.sourceDrift)
      throw new Error(
        'The loaded source changed. Compare the source and session before previewing.'
      );
    const reviewer = this.reviewDrafts.size ? reviewedBy.trim() : '';
    if (this.state === 'previewing' && this.previewPromise) {
      if (this.previewReviewer !== reviewer) throw new Error('Another reviewer preview is running');
      return this.previewPromise;
    }
    if (
      this.busyDone ||
      !this.analysis ||
      !this.inspection ||
      !['inspected', 'reviewing', 'previewed', 'saved'].includes(this.state)
    )
      throw new Error(`Cannot preview while ${this.state}`);
    this.previewResult = undefined;
    this.state = 'reviewing';
    const candidate = this.saveCandidate(this.analysis, reviewer);
    this.previewReviewer = reviewer;
    this.state = 'previewing';
    this.beginBusy();
    this.previewPromise = this.performPreview(this.inspection, candidate);
    return this.previewPromise;
  }

  private planDestination(inspection: LicenseInspection, analysis: LicenseAnalysis) {
    return this.destination.plan(
      inspection,
      analysis,
      this.options,
      this.dependencies,
      this.database
    );
  }

  private async performPreview(
    inspection: LicenseInspection,
    analysis: LicenseAnalysis
  ): Promise<LicensePreview> {
    try {
      const plan = await this.planDestination(inspection, analysis);
      this.previewResult = freezeReviewValue({
        token: randomUUID(),
        candidate: analysis,
        reviewer: this.previewReviewer,
        reviewedAt: this.previewReviewer ? this.candidateReviewedAt : undefined,
        configurationRevision: this.configurationRevision,
        contentRevision: this.contentRevision,
        plan,
        reports: plan.reports,
      });
      this.state = 'previewed';
      return this.previewResult;
    } catch (error) {
      this.previewResult = undefined;
      if (error instanceof LicenseInspectionStaleError && inspection.sourceOnly) {
        this.sourceDrift = true;
        this.state = 'reviewing';
      } else if (error instanceof LicenseInspectionStaleError && !this.reviewDrafts.size) {
        this.inspection = undefined;
        this.analysis = undefined;
        this.state = 'configuring';
      } else this.state = 'reviewing';
      throw error;
    } finally {
      this.previewPromise = undefined;
      this.endBusy();
    }
  }

  save(request: LicenseSaveRequest): Promise<LicenseSaveResult> {
    const frozenRequest = freezeReviewValue(request);
    if (!frozenRequest.operationId.trim()) throw new Error('Save operation ID is required');
    const fingerprint = licenseSaveFingerprint(frozenRequest);
    const prior = this.saveOperations.get(frozenRequest.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error('Save operation ID was reused with different arguments');
      return prior.promise;
    }
    if (this.operations.get(frozenRequest.operationId))
      throw new Error('License operation ID was reused with different arguments');
    this.requireContentRevision(frozenRequest.configurationRevision, frozenRequest.contentRevision);
    if (
      this.busyDone ||
      this.state !== 'previewed' ||
      !this.previewResult ||
      !this.analysis ||
      !this.inspection
    )
      throw new Error('Preview this exact revision before saving');
    const preview = this.previewResult;
    if (frozenRequest.previewToken !== preview.token)
      throw new Error('Stale preview token; preview again before saving');
    if (
      preview.configurationRevision !== frozenRequest.configurationRevision ||
      preview.contentRevision !== frozenRequest.contentRevision
    )
      throw new Error('Stale license preview revision');
    if (preview.plan.conflicts.length)
      throw new Error(`Save conflicts: ${preview.plan.conflicts.join('; ')}`);
    this.state = 'saving';
    this.beginBusy();
    const promise = this.performSave(frozenRequest, preview, this.inspection);
    this.saveOperations.set(frozenRequest.operationId, { fingerprint, promise });
    this.operations.track(
      frozenRequest.operationId,
      'save',
      [
        frozenRequest.configurationRevision,
        frozenRequest.contentRevision,
        frozenRequest.agreeToReplace,
        frozenRequest.previewToken,
      ],
      promise
    );
    return promise;
  }

  private async performSave(
    request: LicenseSaveRequest,
    preview: LicensePreview,
    inspection: LicenseInspection
  ): Promise<LicenseSaveResult> {
    const capture: Partial<LicenseInspection> = {};
    try {
      const result = await writePreviewedLicenseSave({
        capture,
        request,
        preview,
        options: this.options,
        ...this.destination.publication(inspection, this.database),
        fs: this.dependencies.fs,
      });
      this.inspection = freezeReviewValue({ ...inspection, ...capture });
      this.acceptSave(preview);
      return result;
    } catch (error) {
      if (
        inspection.sourceOnly &&
        (error instanceof LicenseInspectionStaleError ||
          (error instanceof LicenseFileDriftError && !destinationSaveFailure(error, this.options)))
      )
        this.sourceDrift = true;
      if (error instanceof LicenseWritePreflightError)
        this.inspection = compensatedLicenseInspection(this.inspection, error.restoredFiles);
      if (
        error instanceof LicenseWritePreflightError ||
        error instanceof LicenseSavePreflightError ||
        ((inspection.sourceOnly || this.reviewDrafts.size) &&
          (error instanceof LicenseInspectionStaleError ||
            error instanceof LicenseFileDriftError ||
            error instanceof LicensePolicyDriftError)) ||
        (inspection.sourceOnly && destinationSaveFailure(error, this.options))
      ) {
        this.previewResult = undefined;
        this.state = 'reviewing';
      } else if (
        error instanceof LicenseInspectionStaleError ||
        error instanceof LicenseFileDriftError ||
        error instanceof LicensePolicyDriftError
      ) {
        this.inspection = undefined;
        this.analysis = undefined;
        this.previewResult = undefined;
        this.state = 'configuring';
      } else {
        this.state = 'uncertain';
        if (error instanceof LicenseWriteUncertainError)
          this.uncertainSave = { request, preview, error, capture };
      }
      throw error;
    } finally {
      this.endBusy();
    }
  }

  async reconcileSave(operationId: string) {
    const pending = this.uncertainSave;
    if (
      this.busyDone ||
      this.state !== 'uncertain' ||
      pending?.request.operationId !== operationId ||
      !pending.error.reconcile
    )
      throw new Error('No uncertain Save with that operation ID is available');
    this.beginBusy();
    try {
      const status = await pending.error.reconcile();
      if (status.outcome === 'planned') {
        this.inspection = freezeReviewValue({ ...this.inspection!, ...pending.capture });
        this.acceptSave(pending.preview);
        const result = confirmedLicenseSave(pending.request, pending.preview);
        this.saveOperations.get(operationId)!.promise = Promise.resolve(result);
        this.operations.confirmSave(operationId, result);
      } else if (status.outcome === 'prior') {
        this.inspection = compensatedLicenseInspection(
          this.inspection,
          pending.error.restoredFiles
        );
        this.previewResult = undefined;
        this.state = 'reviewing';
      }
      if (status.outcome !== 'uncertain') this.uncertainSave = undefined;
      return status;
    } finally {
      this.endBusy();
    }
  }

  exportReport(request: LicenseReportExportRequest): Promise<LicenseReportExportResult> {
    if (this.dependencies.practice)
      throw new Error('Practice cannot export reports outside its scratch workflow');
    const frozen = freezeReviewValue(request);
    return this.operations.run(
      frozen.operationId,
      'export-report',
      [
        frozen.configurationRevision,
        frozen.contentRevision,
        frozen.format,
        frozen.path,
        frozen.expectedPreviousBytes,
        frozen.expectedReportIdentity,
        frozen.reportDirectory,
        frozen.agreeToOverwrite,
      ],
      () => this.exportReportOnce(frozen)
    );
  }

  private async exportReportOnce(
    request: LicenseReportExportRequest
  ): Promise<LicenseReportExportResult> {
    this.requireContentRevision(request.configurationRevision, request.contentRevision);
    const state = this.state;
    if ((state !== 'previewed' && state !== 'saved') || !this.previewResult || !this.inspection)
      throw new Error('Preview this exact revision before exporting a report');
    const preview = this.previewResult;
    this.state = 'exporting';
    this.beginBusy();
    try {
      // Save advanced the source baseline and published the destination. Inspect the current
      // targets before exporting the immutable report from that completed operation.
      if (state === 'saved') {
        const current = await this.planDestination(this.inspection, preview.candidate);
        requireSavedReportTargets(preview.plan, current);
      }
      const result = await exportPreviewedLicenseReport({
        request,
        preview,
        options: this.options,
        ...this.destination.publication(this.inspection, this.database),
        fs: this.dependencies.fs,
      });
      this.state = state;
      return result;
    } catch (error) {
      if (this.inspection?.sourceOnly && error instanceof LicenseInspectionStaleError)
        this.sourceDrift = true;
      if (
        this.sourceDrift ||
        error instanceof LicenseDestinationRecheckError ||
        (this.reviewDrafts.size && error instanceof LicenseInspectionStaleError)
      ) {
        this.previewResult = undefined;
        this.state = 'reviewing';
      } else if (error instanceof LicenseInspectionStaleError && !this.reviewDrafts.size) {
        this.inspection = undefined;
        this.analysis = undefined;
        this.previewResult = undefined;
        this.state = 'configuring';
      } else this.state = state;
      throw error;
    } finally {
      this.endBusy();
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.stopAnalysisRequested = true;
    this.closePromise = (async () => {
      await this.busyDone;
      this.state = 'closed';
      await this.destination.closePools(this.database);
      this.database = undefined;
    })();
    return this.closePromise;
  }
}

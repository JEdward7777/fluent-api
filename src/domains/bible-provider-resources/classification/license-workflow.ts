import { randomUUID } from 'node:crypto';

import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type { FreeSelection } from './license-free-preparation';
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

import { freezeLicenseRevision, freezeReviewValue } from '../license-review-revision';
import { LicenseAnalysisStoppedError } from './license-analysis';
import { LicensePolicyDriftError } from './license-database.types';
import { stageFreePreparation } from './license-free-preparation';
import { LicenseDestinationRecheckError, LicenseInspectionStaleError } from './license-freshness';
import { analyzeInspectedLicenses } from './license-workflow-analyze';
import { LicenseWorkflowDestination } from './license-workflow-destination';
import {
  inspectLicenseWorkflowInputs,
  inspectLoadedLicensePreflight,
  loadedLicenseReview,
  requirePracticeOptions,
} from './license-workflow-inspect';
import { LicenseOperationRegistry } from './license-workflow-operations';
import { exportPreviewedLicenseReport } from './license-workflow-report-export';
import { LicenseWorkflowReview } from './license-workflow-review';
import {
  destinationSaveFailure,
  licenseSaveFingerprint,
  LicenseSavePreflightError,
  writePreviewedLicenseSave,
} from './license-workflow-save';
import { LicenseFileDriftError } from './license-write';

export type { LicenseReviewEdit } from './license-workflow.types';

export class LicenseWorkflow extends LicenseWorkflowReview {
  private options: LicenseCommandOptions;
  private database?: LicenseDatabaseAdapter;
  private readonly destination = new LicenseWorkflowDestination();
  private inspection?: LicenseInspection;
  private previewPromise?: Promise<LicensePreview>;
  private closePromise?: Promise<void>;
  private readonly saveOperations = new Map<string, LicenseSaveOperation>();
  private readonly operations = new LicenseOperationRegistry();
  private readonly completedLaunchSelections = new Set<string>();
  private confirmationNonce = randomUUID();
  private estimate?: Awaited<ReturnType<typeof stageFreePreparation>>['estimate'];
  get paidEstimate() {
    return this.estimate?.contentRevision === this.contentRevision ? this.estimate : undefined;
  }

  private stopAnalysisRequested = false;

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

  async configureLoadedSettings(
    options: LicenseCommandOptions,
    destinationChanged: boolean,
    aiChanged: boolean
  ) {
    this.requireRevision(this.configurationRevision);
    if (this.busyDone || this.state === 'uncertain')
      throw new Error('Cannot configure while an operation runs');
    this.beginBusy();
    try {
      const preflight =
        aiChanged && this.inspection
          ? await inspectLoadedLicensePreflight(options, this.inspection)
          : undefined;
      if (destinationChanged) await this.destination.release(this.database);
      if (preflight && this.inspection)
        this.inspection = freezeReviewValue({ ...this.inspection, preflight });
      this.options = freezeReviewValue(options);
      if (aiChanged) {
        this.estimate = undefined;
        this.completedLaunchSelections.clear();
      }
      this.invalidateConfiguredPreview();
      return this.inspection;
    } finally {
      this.endBusy();
    }
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
      throw new Error('Save outcome uncertain; inspect actual targets in a new process');
    if (this.analysis && this.state !== 'saved' && !discardReviewedState)
      throw new Error('Explicit discard is required before changing reviewed unsaved state');
    this.state = 'reconfiguring';
    this.beginBusy();
    try {
      await this.destination.closePools(this.database);
      this.database = undefined;
      this.options = freezeReviewValue(options);
      this.inspection = undefined;
      this.analysis = undefined;
      this.previewResult = undefined;
      this.configurationRevision++;
      this.contentRevision = 0;
      this.estimate = undefined;
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

  cancelFreeSelection(contentRevision: number, selection: FreeSelection) {
    this.requireContentRevision(this.configurationRevision, contentRevision);
    if (
      this.busyDone ||
      !selection.confirmation ||
      !this.paidEstimate?.replacements.some(
        (row) =>
          row.id === selection.id &&
          row.kind === selection.kind &&
          row.confirmation === selection.confirmation
      )
    )
      throw new Error('Stale reassessment confirmation');
    this.estimate = undefined;
  }

  async prepareFree(contentRevision: number, selection?: FreeSelection) {
    this.requireContentRevision(this.configurationRevision, contentRevision);
    if (this.busyDone || !['inspected', 'reviewing', 'saved', 'previewed'].includes(this.state))
      throw new Error('Cannot prepare assessment while an operation runs');
    const prior = this.state;
    this.state = 'analyzing';
    this.stopAnalysisRequested = false;
    this.beginBusy();
    try {
      await this.prepareLoadedFree(selection);
      return this.paidEstimate!;
    } finally {
      if (this.state === 'analyzing') this.state = prior;
      this.endBusy();
    }
  }

  private async prepareLoadedFree(selection?: FreeSelection) {
    if (!this.analysis || !this.inspection?.sourceOnly)
      throw new Error('Load a review source first');
    if (
      selection?.confirmation &&
      !this.paidEstimate?.replacements.some(
        (row) => row.id === selection.id && row.confirmation === selection.confirmation
      )
    )
      throw new Error('Stale reassessment confirmation');
    const confirmationNonce = selection?.confirmation ? this.confirmationNonce : randomUUID();
    const staged = await stageFreePreparation({
      confirmationNonce,
      completedLaunchSelections: this.completedLaunchSelections,
      options: this.options,
      artifact: this.analysis.artifact,
      eligibility: this.inspection.preflight.rows,
      drafts: this.reviewDrafts,
      contentRevision: this.contentRevision,
      selection,
      now: this.dependencies.now,
    });
    if (this.closing || this.stopAnalysisRequested) throw new LicenseAnalysisStoppedError();
    const estimate = freezeReviewValue(staged.estimate);
    if (staged.free.length) {
      const analysis = freezeReviewValue({
        ...this.analysis,
        artifact: freezeLicenseRevision(staged.artifact),
        contentRevision: estimate.contentRevision,
      });
      this.acceptPreparedRows(staged.free.map((row) => row.normalizedText));
      this.analysis = analysis;
      this.contentRevision = estimate.contentRevision;
      this.previewResult = undefined;
      this.state = 'reviewing';
    }
    for (const key of staged.completedLaunchSelections) this.completedLaunchSelections.add(key);
    this.estimate = estimate;
    this.confirmationNonce = confirmationNonce;
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
    expectedContentRevision: number
  ): Promise<LicensePreview> {
    this.requireContentRevision(expectedConfigurationRevision, expectedContentRevision);
    if (this.reviewDrafts.size)
      throw new Error('Revert pending session edits before using this operation');
    if (this.state === 'previewing' && this.previewPromise) return this.previewPromise;
    if (
      !this.analysis ||
      !this.inspection ||
      !['inspected', 'reviewing', 'previewed'].includes(this.state)
    )
      throw new Error(`Cannot preview while ${this.state}`);
    this.state = 'previewing';
    this.beginBusy();
    this.previewPromise = this.performPreview(this.inspection, this.analysis);
    return this.previewPromise;
  }

  private async performPreview(
    inspection: LicenseInspection,
    analysis: LicenseAnalysis
  ): Promise<LicensePreview> {
    try {
      const plan = await this.destination.plan(
        inspection,
        analysis,
        this.options,
        this.dependencies,
        this.database
      );
      this.previewResult = freezeReviewValue({
        configurationRevision: this.configurationRevision,
        contentRevision: this.contentRevision,
        plan,
        reports: plan.reports,
      });
      this.state = 'previewed';
      return this.previewResult;
    } catch (error) {
      this.previewResult = undefined;
      if (error instanceof LicenseInspectionStaleError) {
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
    if (this.state !== 'previewed' || !this.previewResult || !this.analysis || !this.inspection)
      throw new Error('Preview this exact revision before saving');
    const preview = this.previewResult;
    if (
      preview.configurationRevision !== frozenRequest.configurationRevision ||
      preview.contentRevision !== frozenRequest.contentRevision
    )
      throw new Error('Stale license preview revision');
    if (preview.plan.conflicts.length)
      throw new Error(`Save conflicts: ${preview.plan.conflicts.join('; ')}`);
    this.state = 'saving';
    this.beginBusy();
    const promise = this.performSave(frozenRequest, preview, this.inspection, this.analysis);
    this.saveOperations.set(frozenRequest.operationId, { fingerprint, promise });
    this.operations.track(
      frozenRequest.operationId,
      'save',
      [
        frozenRequest.configurationRevision,
        frozenRequest.contentRevision,
        frozenRequest.agreeToReplace,
      ],
      promise
    );
    return promise;
  }

  private async performSave(
    request: LicenseSaveRequest,
    preview: LicensePreview,
    inspection: LicenseInspection,
    analysis: LicenseAnalysis
  ): Promise<LicenseSaveResult> {
    try {
      const result = await writePreviewedLicenseSave({
        request,
        preview,
        analysis,
        options: this.options,
        ...this.destination.publication(inspection, this.database),
        fs: this.dependencies.fs,
      });
      this.state = 'saved';
      return result;
    } catch (error) {
      if (inspection.sourceOnly && destinationSaveFailure(error, this.options)) {
        this.previewResult = undefined;
        this.state = 'reviewing';
      } else if (
        error instanceof LicenseInspectionStaleError ||
        error instanceof LicenseSavePreflightError ||
        error instanceof LicenseFileDriftError ||
        error instanceof LicensePolicyDriftError
      ) {
        this.inspection = undefined;
        this.analysis = undefined;
        this.previewResult = undefined;
        this.state = 'configuring';
      } else this.state = 'uncertain';
      throw error;
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
        frozen.agreeToOverwrite,
      ],
      () => this.exportReportOnce(frozen)
    );
  }

  private async exportReportOnce(
    request: LicenseReportExportRequest
  ): Promise<LicenseReportExportResult> {
    this.requireContentRevision(request.configurationRevision, request.contentRevision);
    if (this.state !== 'previewed' || !this.previewResult || !this.inspection)
      throw new Error('Preview this exact revision before exporting a report');
    const preview = this.previewResult;
    this.state = 'exporting';
    this.beginBusy();
    try {
      const result = await exportPreviewedLicenseReport({
        request,
        preview,
        options: this.options,
        ...this.destination.publication(this.inspection, this.database),
        fs: this.dependencies.fs,
      });
      this.state = 'previewed';
      return result;
    } catch (error) {
      if (error instanceof LicenseDestinationRecheckError) {
        this.previewResult = undefined;
        this.state = 'reviewing';
      } else if (error instanceof LicenseInspectionStaleError) {
        this.inspection = undefined;
        this.analysis = undefined;
        this.previewResult = undefined;
        this.state = 'configuring';
      } else this.state = 'previewed';
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

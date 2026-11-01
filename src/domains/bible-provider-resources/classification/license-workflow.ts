import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type {
  LicenseAnalysis,
  LicenseInspection,
  LicensePreview,
  LicenseReadOperationRequest,
  LicenseReportExportRequest,
  LicenseReportExportResult,
  LicenseReviewEdit,
  LicenseSaveOperation,
  LicenseSaveRequest,
  LicenseSaveResult,
  LicenseWorkflowDependencies,
  LicenseWorkflowState,
} from './license-workflow.types';

import {
  attestLicenseArtifact,
  checkLicenseArtifactReview,
  serializeLicenseArtifact,
} from '../license-artifact';
import { freezeLicenseRevision, freezeReviewValue } from '../license-review-revision';
import { LicenseAnalysisStoppedError } from './license-analysis';
import { LicensePolicyDriftError } from './license-database.types';
import { LicenseInspectionStaleError, requireFreshLicenseSources } from './license-freshness';
import { buildLicenseSavePlan } from './license-save-plan';
import { analyzeInspectedLicenses } from './license-workflow-analyze';
import { LicenseBootstrapRequiredError } from './license-workflow-freshness';
import { inspectLicenseWorkflowInputs } from './license-workflow-inspect';
import { LicenseOperationRegistry } from './license-workflow-operations';
import { exportPreviewedLicenseReport } from './license-workflow-report-export';
import { applyLicenseReviewEdit } from './license-workflow-review';
import {
  licenseSaveFingerprint,
  LicenseSavePreflightError,
  writePreviewedLicenseSave,
} from './license-workflow-save';
import { LicenseFileDriftError, licenseFileIo } from './license-write';

export { LicenseBootstrapRequiredError } from './license-workflow-freshness';

export type { LicenseReviewEdit } from './license-workflow.types';

export class LicenseWorkflow {
  private options: LicenseCommandOptions;
  private dependencies: LicenseWorkflowDependencies;
  private database?: LicenseDatabaseAdapter;
  private inspection?: LicenseInspection;
  private analysis?: LicenseAnalysis;
  private previewResult?: LicensePreview;
  private previewPromise?: Promise<LicensePreview>;
  private configurationRevision = 1;
  private contentRevision = 0;
  private state: LicenseWorkflowState = 'configuring';
  private closing = false;
  private busyDone?: Promise<void>;
  private finishBusy?: () => void;
  private closePromise?: Promise<void>;
  private readonly saveOperations = new Map<string, LicenseSaveOperation>();
  private readonly operations = new LicenseOperationRegistry();
  private stopAnalysisRequested = false;

  constructor(options: LicenseCommandOptions, dependencies: LicenseWorkflowDependencies) {
    this.options = freezeReviewValue(options);
    this.dependencies = dependencies;
  }

  get status() {
    return freezeReviewValue({
      state: this.state,
      configurationRevision: this.configurationRevision,
      contentRevision: this.contentRevision,
    });
  }
  get analyzed() {
    return this.analysis;
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
    if (this.dependencies.practice) {
      const practice = this.dependencies.practice;
      if (
        options.source !== 'json' ||
        options.destination !== 'json' ||
        options.input !== practice.input ||
        options.output !== practice.output ||
        options.cacheDir !== practice.cacheDir ||
        options.reportDir !== practice.reportDir
      )
        throw new Error('Practice is confined to its JSON scratch paths');
    }
    this.requireRevision(expectedRevision);
    if (
      ['inspecting', 'analyzing', 'previewing', 'reconfiguring', 'saving', 'exporting'].includes(
        this.state
      )
    )
      throw new Error(`Cannot configure while ${this.state}`);
    if (this.state === 'uncertain')
      throw new Error('Save outcome uncertain; inspect actual targets in a new process');
    if (this.analysis && this.state !== 'saved' && !discardReviewedState)
      throw new Error('Explicit discard is required before changing reviewed unsaved state');
    this.state = 'reconfiguring';
    this.beginBusy();
    try {
      await this.database?.close?.();
      this.database = undefined;
      this.options = freezeReviewValue(options);
      this.inspection = undefined;
      this.analysis = undefined;
      this.previewResult = undefined;
      this.configurationRevision++;
      this.contentRevision = 0;
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
      this.state = 'inspected';
      return this.inspection;
    } catch (error) {
      this.inspection = undefined;
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
    if (this.state !== 'inspected' || !this.inspection)
      throw new Error('Inspect inputs before starting analysis');
    const inspection = this.inspection;
    const options = this.options;
    if (
      options.source === 'database' &&
      options.destination !== 'json' &&
      !inspection.database?.classifications.length
    )
      throw new LicenseBootstrapRequiredError();
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

  editReview(
    edit: LicenseReviewEdit,
    expectedConfigurationRevision: number,
    expectedContentRevision: number
  ) {
    this.requireContentRevision(expectedConfigurationRevision, expectedContentRevision);
    if (!this.analysis || !['reviewing', 'previewed'].includes(this.state))
      throw new Error(`Cannot edit review while ${this.state}`);
    const before = this.analysis.artifact;
    const { artifact, warning } = applyLicenseReviewEdit(before, edit);
    if (serializeLicenseArtifact(artifact).bytes !== serializeLicenseArtifact(before).bytes) {
      this.analysis = freezeReviewValue({
        ...this.analysis,
        contentRevision: ++this.contentRevision,
        artifact,
      });
      this.previewResult = undefined;
      this.state = 'reviewing';
    }
    return freezeReviewValue({ analysis: this.analysis, warning });
  }

  async preview(
    expectedConfigurationRevision: number,
    expectedContentRevision: number
  ): Promise<LicensePreview> {
    this.requireContentRevision(expectedConfigurationRevision, expectedContentRevision);
    if (this.state === 'previewing' && this.previewPromise) return this.previewPromise;
    if (!this.analysis || !this.inspection || !['reviewing', 'previewed'].includes(this.state))
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
      if (!this.dependencies.legacySkipFreshness)
        await requireFreshLicenseSources(
          inspection,
          this.options,
          this.dependencies.fs ?? licenseFileIo,
          this.database
        );
      const plan = buildLicenseSavePlan({
        options: this.options,
        artifact: analysis.artifact,
        originalSourceArtifact: analysis.originalSourceArtifact,
        inputBytes: inspection.inputBytes,
        outputBytes: inspection.outputBytes,
        database: inspection.database,
      });
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
    if (preview.plan.requiresForceAgreement && !frozenRequest.agreeToReplace)
      throw new Error('Explicit agreement is required to replace the existing policy table');
    if (preview.plan.requiresForceAgreement && !this.options.force)
      throw new Error('Select force replacement and preview again before saving');
    if (
      preview.plan.replace &&
      checkLicenseArtifactReview(this.analysis.artifact).status !== 'ready'
    )
      throw new Error('Attested review and human notes for retained unknowns are required');
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
        inspection,
        analysis,
        options: this.options,
        database: this.database,
        fs: this.dependencies.fs,
      });
      this.state = 'saved';
      return result;
    } catch (error) {
      if (
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
        inspection: this.inspection,
        options: this.options,
        database: this.database,
        fs: this.dependencies.fs,
      });
      this.state = 'previewed';
      return result;
    } catch (error) {
      if (error instanceof LicenseInspectionStaleError) {
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

  attest(
    metadata: { reviewedBy: string; reviewReason: string; reviewedAt: string },
    expectedConfigurationRevision: number,
    expectedContentRevision: number,
    expectedReviewHash: string
  ) {
    if (this.dependencies.practice) throw new Error('Practice cannot attest a review');
    this.requireContentRevision(expectedConfigurationRevision, expectedContentRevision);
    if (!this.analysis || this.state !== 'previewed' || !this.previewResult)
      throw new Error('Preview this exact revision before attestation');
    if (this.previewResult.reports.reviewContentHash !== expectedReviewHash)
      throw new Error('Stale license review hash');
    if (!metadata.reviewedBy.trim() || !metadata.reviewReason.trim())
      throw new Error('Reviewer identity and review reason are required');
    const artifact = freezeLicenseRevision(attestLicenseArtifact(this.analysis.artifact, metadata));
    if (
      serializeLicenseArtifact(artifact).bytes !==
      serializeLicenseArtifact(this.analysis.artifact).bytes
    )
      this.analysis = freezeReviewValue({
        ...this.analysis,
        contentRevision: ++this.contentRevision,
        artifact,
      });
    this.previewResult = undefined;
    this.state = 'reviewing';
    return this.analysis;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.stopAnalysisRequested = true;
    this.closePromise = (async () => {
      await this.busyDone;
      this.state = 'closed';
      await this.database?.close?.();
      this.database = undefined;
    })();
    return this.closePromise;
  }

  private requireRevision(expectedRevision: number) {
    if (expectedRevision !== this.configurationRevision)
      throw new Error('Stale license workflow configuration revision');
    if (this.state === 'closed' || this.closing) throw new Error('License workflow is closed');
  }

  private requireContentRevision(
    expectedConfigurationRevision: number,
    expectedContentRevision: number
  ) {
    this.requireRevision(expectedConfigurationRevision);
    if (expectedContentRevision !== this.contentRevision)
      throw new Error('Stale license workflow content revision');
  }

  private beginBusy() {
    this.busyDone = new Promise<void>((resolve) => {
      this.finishBusy = resolve;
    });
  }

  private endBusy() {
    this.finishBusy?.();
    this.finishBusy = undefined;
    this.busyDone = undefined;
  }
}

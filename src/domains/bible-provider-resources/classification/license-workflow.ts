import { resolve } from 'node:path';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseCommandOptions } from './license-command-options';
import type { LicenseDatabaseAdapter } from './license-database.types';
import type {
  LicenseAnalysis,
  LicenseInspection,
  LicensePreview,
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
  overrideLicenseClassification,
  reviseLicenseArtifact,
  serializeLicenseArtifact,
} from '../license-artifact';
import { createLicenseClassifier } from '../license-classifier';
import { freezeLicenseRevision, freezeReviewValue } from '../license-review-revision';
import { analyzeDatabaseLicenses } from './license-analysis';
import { LicensePolicyDriftError } from './license-database.types';
import { LicenseInspectionStaleError, requireFreshLicenseSources } from './license-freshness';
import { inspectLicensePreflight } from './license-preflight';
import { buildLicenseSavePlan } from './license-save-plan';
import {
  LicenseBootstrapRequiredError,
  parseLicenseArtifactBytes,
  requireFreshLicenseInspection,
} from './license-workflow-freshness';
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

  get previewed() {
    return this.previewResult;
  }

  get databaseAdapter() {
    return this.database;
  }

  async configure(options: LicenseCommandOptions, expectedRevision: number) {
    this.requireRevision(expectedRevision);
    if (['inspecting', 'analyzing', 'previewing', 'reconfiguring', 'saving'].includes(this.state))
      throw new Error(`Cannot configure while ${this.state}`);
    if (this.state === 'uncertain')
      throw new Error('Save outcome uncertain; inspect actual targets in a new process');
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

  async inspect(expectedRevision: number): Promise<LicenseInspection> {
    this.requireRevision(expectedRevision);
    if (this.state !== 'configuring' && this.state !== 'error')
      throw new Error(`Cannot inspect while ${this.state}`);
    if (!this.dependencies.apiKey.trim())
      throw new Error('A nonempty GEMINI_API_KEY is required before reading any source');
    const options = this.options;
    if (!options.source || !options.destination)
      throw new Error('Select both source and destination before analysis');
    if (!/^google:[^\s:]+$/.test(options.model))
      throw new Error(`Unsupported model reference: ${options.model}. Use google:<model-id>`);
    if (!Number.isInteger(options.sampleCount) || options.sampleCount < 2)
      throw new Error('Sample count must be an integer of at least two');
    this.state = 'inspecting';
    this.beginBusy();
    try {
      const fs = this.dependencies.fs ?? licenseFileIo;
      const needsDatabase = options.source === 'database' || options.destination !== 'json';
      if (needsDatabase && !this.database) {
        if (this.dependencies.database) this.database = await this.dependencies.database();
        else {
          const { createOwnedLicenseDatabaseAdapter } =
            await import('./license-classifications.service');
          const { default: environment } = await import('@/env');
          this.database = createOwnedLicenseDatabaseAdapter(environment.DATABASE_URL);
        }
      }
      const loaded = await this.database?.load();
      const snapshot = loaded ? freezeReviewValue(loaded) : undefined;
      if (options.destination !== 'json' && !snapshot?.tableExists)
        throw new Error(
          'The license_classifications table must exist before a database destination can be used'
        );
      if (
        options.source === 'database' &&
        options.destination !== 'json' &&
        !snapshot?.classifications.length
      )
        throw new LicenseBootstrapRequiredError();
      const inputBytes = options.source === 'json' ? await fs.read(options.input) : null;
      if (options.source === 'json' && inputBytes === null)
        throw new Error(`JSON source not found: ${options.input}`);
      const samePath = resolve(options.output) === resolve(options.input);
      const outputBytes =
        samePath && options.source === 'json' ? inputBytes : await fs.read(options.output);
      const preflight = await inspectLicensePreflight({
        database: options.source === 'database' ? snapshot : undefined,
        jsonClassificationKeys:
          options.source === 'json'
            ? parseLicenseArtifactBytes(inputBytes!).classifications.map(
                (row) => row.normalizedText
              )
            : undefined,
        model: options.model,
        sampleCount: options.sampleCount,
        cacheDir: options.cacheDir,
        noCache: options.noCache,
      });
      this.inspection = freezeReviewValue({
        configurationRevision: this.configurationRevision,
        inspectedAt: this.dependencies.now?.() ?? new Date().toISOString(),
        inputBytes,
        outputBytes,
        preflight,
        ...(snapshot ? { database: snapshot } : {}),
      });
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

  async startAnalysis(expectedRevision: number): Promise<LicenseAnalysis> {
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
    this.beginBusy();
    try {
      if (!this.dependencies.legacySkipFreshness)
        await requireFreshLicenseInspection(
          inspection,
          options,
          this.dependencies.fs ?? licenseFileIo,
          this.database
        );
      const base =
        options.source === 'database' && inspection.outputBytes !== null
          ? parseLicenseArtifactBytes(inspection.outputBytes)
          : undefined;
      const artifact =
        options.source === 'json'
          ? parseLicenseArtifactBytes(inspection.inputBytes!)
          : await analyzeDatabaseLicenses({
              catalog: inspection.database!.context.resources.map(
                ({ ttsLicenseStatus: _status, ...row }) => row
              ),
              classifications: inspection.database!.classifications,
              base,
              classify: createLicenseClassifier({
                apiKey: this.dependencies.apiKey,
                model: options.model,
                sampleCount: options.sampleCount,
                cacheDir: options.cacheDir,
                noCache: options.noCache,
                transport: this.dependencies.transport,
              }),
              model: options.model,
              sampleCount: options.sampleCount,
            });
      const frozen = freezeLicenseRevision(artifact);
      this.analysis = freezeReviewValue({
        configurationRevision: this.configurationRevision,
        contentRevision: ++this.contentRevision,
        artifact: frozen,
        ...(options.source === 'json' ? { originalSourceArtifact: frozen } : {}),
      });
      this.state = 'reviewing';
      return this.analysis;
    } catch (error) {
      if (error instanceof LicenseInspectionStaleError) {
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
    let revised: LicenseArtifact;
    let warning: string | null = null;
    if (edit.kind === 'disposition') {
      const result = overrideLicenseClassification(
        before,
        edit.normalizedText,
        edit.status,
        edit.reason
      );
      revised = result.artifact;
      warning = result.warning;
    } else {
      if (!edit.note.trim()) throw new Error('A retained unknown requires a nonempty human note');
      const row = before.classifications.find(
        (candidate) => candidate.normalizedText === edit.normalizedText
      );
      if (!row) throw new Error('No exact normalized classification exists');
      if (row.status !== 'unknown')
        throw new Error('Human row notes are for retained unknown classifications');
      revised = reviseLicenseArtifact(before, (draft) => {
        draft.classifications.find(
          (candidate) => candidate.normalizedText === edit.normalizedText
        )!.rowNote = edit.note;
      });
    }
    const artifact = freezeLicenseRevision(revised);
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

  attest(
    metadata: { reviewedBy: string; reviewReason: string; reviewedAt: string },
    expectedConfigurationRevision: number,
    expectedContentRevision: number,
    expectedReviewHash: string
  ) {
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

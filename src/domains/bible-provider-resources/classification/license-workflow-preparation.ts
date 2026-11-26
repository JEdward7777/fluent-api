import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseCommandOptions } from './license-command-options';
import type { FreeSelection } from './license-free-preparation';
import type { PaidAuthorization } from './license-paid-batch';
import type { LicenseInspection } from './license-workflow.types';

import { displayLicenseNotice, isLicenseNoticeUnavailable } from '../license-normalizer';
import {
  freezeLicenseRevision,
  freezeReviewValue,
  licenseRowRevision,
} from '../license-review-revision';
import { LicenseAnalysisStoppedError } from './license-analysis';
import { licenseKeyDigest } from './license-eligibility';
import { stageFreePreparation } from './license-free-preparation';
import { PaidBatchError, stagePaidBatch } from './license-paid-batch';
import { LicenseWorkflowReview } from './license-workflow-review';

export abstract class LicenseWorkflowPreparation extends LicenseWorkflowReview {
  protected abstract options: LicenseCommandOptions;
  protected abstract inspection?: LicenseInspection;
  protected readonly completedLaunchSelections = new Map<
    string,
    ReturnType<typeof licenseRowRevision>
  >();

  private recordCompletedSelections(keys: string[], artifact: LicenseArtifact) {
    if (!keys.length) return;
    const byId = new Map(
      artifact.classifications.map((row) => [licenseKeyDigest(row.normalizedText), row])
    );
    for (const key of keys) {
      const id = key.slice(key.indexOf(':') + 1);
      const row = byId.get(id)!;
      this.completedLaunchSelections.set(key, licenseRowRevision(row, artifact.classificationRun));
    }
  }

  protected reconcileSelections(
    artifact: LicenseArtifact,
    preflight: LicenseInspection['preflight']
  ) {
    const rows = new Map(artifact.classifications.map((row) => [row.normalizedText, row]));
    const notices = new Map(preflight.rows.map((row) => [row.normalizedText, row.exampleNotice]));
    const selected =
      this.modelScope &&
      artifact.classifications.find(
        (row) => licenseKeyDigest(row.normalizedText) === this.modelScope?.id
      );
    if (
      this.modelScope?.modelRun !== 'fresh' ||
      !selected ||
      isLicenseNoticeUnavailable(notices.get(selected.normalizedText) ?? selected.exampleNotice)
    )
      this.modelScope = undefined;
    this.invalidatePaidEstimate();
    for (const [key, basis] of this.completedLaunchSelections) {
      const row = rows.get(basis.row.normalizedText);
      if (
        !row ||
        notices.get(row.normalizedText) !== basis.row.exampleNotice ||
        !isDeepStrictEqual(licenseRowRevision(row, artifact.classificationRun), basis)
      )
        this.completedLaunchSelections.delete(key);
    }
  }
  private modelScope?: FreeSelection;
  get selectedModelId() {
    return this.modelScope?.id ?? null;
  }
  get selectedModelNotice() {
    const id = this.selectedModelId;
    if (!id) return null;
    const row = this.analysis?.artifact.classifications.find(
      (item) => licenseKeyDigest(item.normalizedText) === id
    );
    const plan = this.inspection?.preflight.rows.find(
      (item) => item.normalizedText === row?.normalizedText
    );
    return { id, notice: displayLicenseNotice(plan?.exampleNotice ?? row?.exampleNotice ?? null) };
  }
  private estimateGeneration = randomUUID();
  protected resetModelSelection() {
    this.modelScope = undefined;
    this.invalidatePaidEstimate();
  }
  protected invalidatePaidEstimate() {
    this.estimate = undefined;
    this.estimateGeneration = randomUUID();
  }
  get hasPaidCredential() {
    return !this.dependencies.practice && Boolean(this.dependencies.apiKey.trim());
  }
  private confirmationNonce = randomUUID();
  protected estimate?: Awaited<ReturnType<typeof stageFreePreparation>>['estimate'];
  get paidEstimate() {
    return this.estimate?.contentRevision === this.contentRevision ? this.estimate : undefined;
  }

  protected stopAnalysisRequested = false;

  cancelFreeSelection(contentRevision: number, selection: FreeSelection) {
    this.requireContentRevision(this.configurationRevision, contentRevision);
    const estimate = this.paidEstimate;
    const currentModel =
      this.modelScope?.id === selection.id &&
      selection.kind === 'model' &&
      selection.confirmation === estimate?.fingerprint;
    const currentReplacement = estimate?.replacements.some(
      (row) =>
        row.id === selection.id &&
        row.kind === selection.kind &&
        row.confirmation === selection.confirmation
    );
    if (this.busyDone || !selection.confirmation || !(currentModel || currentReplacement))
      throw new Error('Stale reassessment confirmation');
    this.resetModelSelection();
  }

  async prepareFree(contentRevision: number, selection?: FreeSelection, renewEstimate = false) {
    this.requireContentRevision(this.configurationRevision, contentRevision);
    if (this.busyDone || !['inspected', 'reviewing', 'saved', 'previewed'].includes(this.state))
      throw new Error('Cannot prepare assessment while an operation runs');
    const prior = this.state;
    this.state = 'analyzing';
    this.stopAnalysisRequested = false;
    this.beginBusy();
    try {
      await this.prepareLoadedFree(
        selection ?? this.modelScope,
        renewEstimate || Boolean(selection?.modelRun)
      );
      if (selection)
        this.modelScope =
          selection.modelRun === 'fresh'
            ? { id: selection.id, kind: 'model', modelRun: 'fresh' }
            : undefined;
      return this.paidEstimate!;
    } finally {
      if (this.state === 'analyzing') this.state = prior;
      this.endBusy();
    }
  }

  protected async prepareLoadedFree(selection?: FreeSelection, renewEstimate = false) {
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
    const sameSelection =
      this.estimate?.selection?.id === selection?.id &&
      this.estimate?.selection?.kind === selection?.kind;
    const estimateGeneration =
      sameSelection && !renewEstimate ? this.estimateGeneration : randomUUID();
    const staged = await stageFreePreparation({
      estimateGeneration,
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
    if (staged.free.length)
      this.promotePreparedRows(
        staged.artifact,
        staged.free.map((row) => row.normalizedText)
      );
    this.recordCompletedSelections(staged.completedLaunchSelections, this.analysis.artifact);
    this.estimate = estimate;
    this.confirmationNonce = confirmationNonce;
    this.estimateGeneration = estimateGeneration;
  }

  private promotePreparedRows(artifact: LicenseArtifact, keys: string[]) {
    const replacing = new Set(keys);
    const classifications = artifact.classifications.map((row) => {
      if (!replacing.has(row.normalizedText)) return row;
      const draft = this.reviewDrafts.values(row);
      if (!draft.pending) return row;
      return {
        ...row,
        reviewHistory: [
          ...(row.reviewHistory ?? []),
          {
            status: draft.status,
            source: 'manual' as const,
            reviewState: 'pending_human_review' as const,
            reviewComment: draft.reviewComment,
            rationale: null,
            rowNote: null,
            reviewedBy: null,
            decisionAt: null,
            humanReviewedAt: null,
          },
        ],
      };
    });
    const analysis = freezeReviewValue({
      ...this.analysis!,
      artifact: freezeLicenseRevision({ ...artifact, classifications }),
      contentRevision: this.contentRevision + 1,
    });
    this.acceptPreparedRows(keys);
    this.analysis = analysis;
    this.contentRevision = analysis.contentRevision;
    this.previewResult = undefined;
    this.state = 'reviewing';
    return analysis;
  }

  async runPaid(
    authorization: PaidAuthorization,
    progress: { attempts: number; completedRows: number }
  ) {
    const estimate = this.paidEstimate;
    if (
      this.busyDone ||
      !this.analysis ||
      !this.inspection?.sourceOnly ||
      !estimate ||
      estimate.fingerprint !== authorization.fingerprint ||
      !['inspected', 'reviewing', 'saved', 'previewed'].includes(this.state)
    )
      throw new PaidBatchError(
        'Estimate changed. Check the current estimate before authorizing a batch.'
      );
    const prior = this.state;
    this.beginBusy();
    this.stopAnalysisRequested = false;
    this.state = 'analyzing';
    const stop = () => this.closing || this.stopAnalysisRequested;
    try {
      const staged = await stageFreePreparation({
        estimateGeneration: this.estimateGeneration,
        confirmationNonce: this.confirmationNonce,
        completedLaunchSelections: this.completedLaunchSelections,
        options: this.options,
        artifact: this.analysis.artifact,
        eligibility: this.inspection.preflight.rows,
        drafts: this.reviewDrafts,
        contentRevision: this.contentRevision,
        selection: this.modelScope ?? estimate.selection ?? undefined,
        now: this.dependencies.now,
      });
      const result = await stagePaidBatch({
        staged,
        authorization,
        artifact: this.analysis.artifact,
        options: this.options,
        dependencies: this.dependencies,
        stop,
        progress,
      });
      if (stop()) throw new LicenseAnalysisStoppedError();
      const analysis = this.promotePreparedRows(
        result.artifact,
        result.eligibility.map((row) => row.normalizedText)
      );
      const launch = new Set(this.options.rerunModel);
      this.recordCompletedSelections(
        estimate.outstanding.filter((row) => launch.has(row.id)).map((row) => `model:${row.id}`),
        analysis.artifact
      );
      if (this.modelScope) this.modelScope = { ...this.modelScope, modelRun: 'completed' };
      this.invalidatePaidEstimate();
      return analysis;
    } catch (error) {
      this.state = prior;
      this.invalidatePaidEstimate();
      if (stop()) throw new PaidBatchError('Paid batch stopped. Working decisions were kept.');
      throw error;
    } finally {
      this.endBusy();
    }
  }
}

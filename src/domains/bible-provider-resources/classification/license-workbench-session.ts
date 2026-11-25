import type { z } from 'zod';

import { createHash } from 'node:crypto';

import type { PaidAuthorization } from './license-paid-batch';
import type { LicensePractice } from './license-practice';
import type { DraftCommand } from './license-review-drafts';
import type { VisibleOperation } from './license-workbench-operation.types';
import type { operationSchema } from './license-workbench-schema';
import type { LicenseReviewEdit } from './license-workflow.types';

import { licenseApiKey } from './license-api-key';
import { createLicensePractice } from './license-practice';
import { LicenseWorkbenchConfiguration } from './license-workbench-configuration';
import { ownedWorkbenchDatabase } from './license-workbench-database';
import { licenseWorkbenchBrowserError } from './license-workbench-error';
import { LicenseWorkflow } from './license-workflow';
import { LicenseWriteUncertainError } from './license-write';

export class LicenseWorkbenchSession extends LicenseWorkbenchConfiguration {
  private uncertainReceipt?: VisibleOperation['result'];

  async reconcileSave(operationId: string) {
    const operation = this.operations.get(operationId)?.snapshot;
    if (operation?.kind !== 'save') throw new Error('Unknown Save operation');
    if (operation.reconciliation && operation.reconciliation.outcome !== 'uncertain')
      return operation;
    if (!this.workflow || this.latestSaveOperationId !== operationId)
      throw new Error('Unknown active Save operation');
    const workflow = this.workflow;
    return this.reserve(async () => {
      operation.reconciliation = await workflow.reconcileSave(operationId);
      if (operation.reconciliation.outcome === 'planned') {
        operation.state = 'succeeded';
        operation.result = this.uncertainReceipt;
        delete operation.error;
      }
      if (operation.reconciliation.outcome !== 'uncertain') this.uncertainReceipt = undefined;
      return operation;
    });
  }
  private pendingLoad?: Promise<void>;
  start(
    kind: VisibleOperation['kind'],
    body: z.infer<typeof operationSchema> & { paid?: PaidAuthorization }
  ) {
    const fingerprint = JSON.stringify([
      kind,
      body.configurationRevision,
      Boolean(body.discardReviewedState),
      body.expectedContentRevision,
      body.paid,
    ]);
    if (this.rerunOperations.get(body.operationId))
      throw new Error('Operation ID was reused with different arguments');
    const prior = this.operations.get(body.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error('Operation ID was reused with different arguments');
      return { ...prior.snapshot };
    }
    if (this.closed || this.preparing || this.activeOperationId || this.testing)
      throw new Error('Another operation is running or the session is closed');
    if (this.workflow?.status.state === 'uncertain')
      throw new Error('Save outcome uncertain; check the actual Save targets before continuing');
    if (body.configurationRevision !== this.visible.configurationRevision)
      throw new Error('Configuration changed; reload setup before continuing');
    if (!this.options.source) throw new Error('Choose a source');
    if (kind === 'analysis' || kind === 'paid') this.requireSelectedSourceLoaded();
    let candidate: LicenseWorkflow | undefined;
    let candidatePractice: LicensePractice | undefined;
    if (kind === 'inspect') {
      if (
        this.workflow?.analyzed &&
        !this.sourceDraftPending &&
        !['configuring', 'error'].includes(this.workflow.status.state)
      )
        throw new Error('The selected source is already loaded');
      if (
        body.discardReviewedState &&
        this.workflow?.analyzed &&
        body.expectedContentRevision !== this.workflow.status.contentRevision
      )
        throw new Error(
          'Discard confirmation is stale. Review the current content revision before replacing this source.'
        );
      if (
        this.workflow?.analyzed &&
        !['inspected', 'saved', 'error'].includes(this.workflow.status.state) &&
        (body.discardReviewedState ? body.expectedContentRevision : this.discardRevision) !==
          this.workflow.status.contentRevision
      )
        throw new Error(
          'Explicit discard acknowledgement for the current content revision is required to load a different source and replace the current review'
        );
    }
    if (kind === 'inspect' && !this.practiceMode) {
      candidate = new LicenseWorkflow(this.options, {
        apiKey: this.injected?.apiKey ?? licenseApiKey(),
        database:
          this.injected?.database ??
          (async () => ownedWorkbenchDatabase(this.databaseConnection, 'source')),
        destinationDatabase:
          this.injected?.destinationDatabase ??
          this.injected?.database ??
          (async () => ownedWorkbenchDatabase(this.destinationConnection)),
        transport: this.injected?.transport,
        fs: this.injected?.fs,
        now: this.injected?.now,
      });
    }
    if (!this.workflow && kind !== 'inspect')
      throw new Error('Inspect inputs before starting analysis');
    const operation: VisibleOperation = { operationId: body.operationId, kind, state: 'running' };
    this.operations.set(body.operationId, { fingerprint, snapshot: operation });
    this.activeOperationId = body.operationId;
    this.latestOperationId = body.operationId;
    const promise = (async () => {
      if (kind === 'inspect' && this.practiceMode) {
        candidatePractice = await createLicensePractice(this.selectedPracticePath);
        candidate = candidatePractice.workflow;
      }
      const workflow = candidate ?? this.workflow;
      if (!workflow) throw new Error('Inspect inputs before starting analysis');
      const coreRequest = {
        ...body,
        configurationRevision: workflow.status.configurationRevision,
      };
      if (kind === 'paid' && body.paid) {
        operation.progress = {
          attempts: 0,
          completedRows: 0,
          totalRows: workflow.paidEstimate?.outstanding.length ?? 0,
        };
        return workflow.runPaid(body.paid, operation.progress);
      }
      return kind === 'inspect'
        ? workflow.inspect(coreRequest)
        : workflow.startAnalysis(coreRequest);
    })();
    const closeReplacedWorkflow = async (retired?: LicenseWorkflow, practice?: LicensePractice) => {
      try {
        await retired?.close();
        await practice?.discardUnpublishedScratch();
      } catch {
        operation.cleanupWarning = 'The retired review reported a cleanup failure.';
      }
    };
    this.pendingLoad = promise
      .then(
        async (result) => {
          if (kind === 'inspect') {
            this.loadRevision++;
            if (this.options.source === 'database' && !this.destinationInitialized) {
              this.destinationConnection = { ...this.databaseConnection };
              this.destinationInitialized = true;
              this.destinationRevision++;
              this.destinationConnectionRevision++;
              this.destinationTests.appliedStatus = 'untested';
            }
            if (candidate) {
              const prior = this.workflow;
              const priorPractice = this.practice;
              if (prior) this.configurationRevision++;
              this.reports.clear();
              this.workflow = candidate;
              if (candidatePractice) {
                this.practice = candidatePractice;
                this.options = candidatePractice.options;
                this.loadedPracticePath = this.selectedPracticePath;
              }
              this.loadedOptions = this.options;
              this.loadedConnection = this.databaseConnection;
              this.discardRevision = undefined;
              this.latestSaveOperationId = undefined;
              await closeReplacedWorkflow(prior, priorPractice);
            }
          }
          if (kind === 'inspect' && 'preflight' in result)
            this.inspected = { inspectedAt: result.inspectedAt, preflight: result.preflight };
          if (kind === 'inspect' && 'inputBytes' in result)
            this.sourceHash =
              result.inputBytes === null
                ? undefined
                : createHash('sha256').update(result.inputBytes).digest('hex');
          if (kind === 'inspect' && 'database' in result)
            this.policyBaseline = result.database?.classifications;
          operation.state = 'succeeded';
        },
        async (error: unknown) => {
          await closeReplacedWorkflow(candidate, candidatePractice);
          operation.state = 'failed';
          operation.error = licenseWorkbenchBrowserError(error);
        }
      )
      .finally(() => {
        this.activeOperationId = undefined;
      });
    return { ...operation };
  }
  stop() {
    if (!this.workflow) throw new Error('No analysis is running');
    const status = this.workflow.requestStopAnalysis();
    const operation = this.activeOperationId && this.operations.get(this.activeOperationId);
    if (operation && operation.snapshot.progress) operation.snapshot.progress.stopRequested = true;
    return status;
  }
  mutateDraft(body: DraftCommand) {
    if (!this.workflow)
      return {
        id: body.id,
        mutationId: body.mutationId,
        epoch: null,
        contentRevision: 0,
        conflict: true as const,
        values: null,
      };
    return this.workflow.mutateDraft(
      body,
      !this.closed && !this.preparing && !this.activeOperationId && !this.testing
    );
  }
  editReview(body: {
    configurationRevision: number;
    contentRevision: number;
    id: string;
    edit: LicenseReviewEdit;
    acknowledgeWarning: boolean;
  }) {
    if (this.preparing || this.activeOperationId || this.testing)
      throw new Error('An operation is running; wait before editing');
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
  async previewPractice(configurationRevision: number, contentRevision: number, reviewedBy = '') {
    return this.preview(configurationRevision, contentRevision, true, reviewedBy);
  }
  async preview(
    configurationRevision: number,
    contentRevision: number,
    practice = false,
    reviewedBy = ''
  ) {
    if (this.practiceMode !== practice || !this.workflow)
      throw new Error('Preview is unavailable in this mode');
    if (this.activeOperationId) throw new Error('An operation is running');
    if (configurationRevision !== this.configurationRevision)
      throw new Error('Stale configuration revision');
    const workflow = this.workflow;
    if (workflow.status.state === 'previewing')
      return workflow.preview(workflow.status.configurationRevision, contentRevision, reviewedBy);
    return this.reserve(() =>
      workflow.preview(workflow.status.configurationRevision, contentRevision, reviewedBy)
    );
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
    if (this.preparing || this.activeOperationId || this.testing)
      throw new Error('An operation is running');
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
    previewToken: string;
    configurationRevision: number;
    contentRevision: number;
    format: 'html' | 'markdown';
    path: string;
  }) {
    if (this.practiceMode || !this.workflow)
      throw new Error('Practice cannot inspect report targets');
    if (this.activeOperationId) throw new Error('An operation is running');
    if (this.workflow.status.state === 'uncertain')
      throw new Error('Save outcome uncertain; check the actual Save targets before continuing');
    const workflow = this.workflow;
    return this.reserve(() => this.reports.inspect(workflow, this.configurationRevision, body));
  }

  exportReport(body: { planId: string; operationId: string; agreeToOverwrite: boolean }) {
    if (this.practiceMode || !this.workflow) throw new Error('Practice cannot export reports');
    if (this.activeOperationId) throw new Error('An operation is running');
    if (this.workflow.status.state === 'uncertain')
      throw new Error('Save outcome uncertain; check the actual Save targets before continuing');
    const workflow = this.workflow;
    return this.reserve(() => this.reports.export(workflow, this.configurationRevision, body));
  }

  async savePractice(body: {
    previewToken: string;
    operationId: string;
    configurationRevision: number;
    contentRevision: number;
  }) {
    if (!this.practiceMode || !this.workflow) throw new Error('Practice save is unavailable');
    return this.save({ ...body, agreeToReplace: false });
  }

  save(body: {
    previewToken: string;
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
      body.previewToken,
    ]);
    if (this.rerunOperations.get(body.operationId))
      throw new Error('Operation ID was reused with different arguments');
    const prior = this.operations.get(body.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error('Operation ID was reused with different arguments');
      return { ...prior.snapshot };
    }
    if (this.closed || this.preparing || this.activeOperationId || this.testing)
      throw new Error('Another operation is running or the session is closed');
    if (!this.workflow) throw new Error('Preview before saving');
    if (body.configurationRevision !== this.configurationRevision)
      throw new Error('Stale configuration revision');
    if (this.practiceMode && body.agreeToReplace)
      throw new Error('Practice cannot replace database policy');
    const preview = this.workflow.previewed;
    if (!preview || preview.contentRevision !== body.contentRevision)
      throw new Error('Preview this exact revision before saving');
    if (preview.token !== body.previewToken)
      throw new Error('Stale preview token; preview again before saving');
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
    const receipt = {
      wholeFileHash: preview.plan.wholeFileHash,
      targets: preview.plan.targets.map((target) => ({
        path: target.path,
        role: target.role,
        hash: preview.plan.wholeFileHash,
      })),
      policy: policy
        ? {
            inserts: policy.inserts.length,
            updates: policy.updates.length,
            deletes: policy.deletes.length,
            preserved: preview.plan.databaseChanges.preserved.length,
            reviewContentHash: preview.plan.databaseForecast?.reviewContentHash,
          }
        : null,
      incomplete,
    };
    void promise.then(
      () => {
        operation.state = 'succeeded';
        operation.result = receipt;
        this.activeOperationId = undefined;
      },
      (error: unknown) => {
        operation.state = 'failed';
        operation.error = licenseWorkbenchBrowserError(error);
        if (error instanceof LicenseWriteUncertainError) {
          operation.recovery = error.recovery;
          this.uncertainReceipt = receipt;
        }
        this.activeOperationId = undefined;
      }
    );
    return { ...operation };
  }

  async close() {
    this.closed = true;
    await Promise.all([this.databaseTests.settle(), this.destinationTests.settle()]);
    await Promise.all([this.pendingLoad, this.workflow?.close()]);
    await this.workflow?.close();
  }
}

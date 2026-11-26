import type { FreeSelection } from './license-free-preparation';
import type { PaidAuthorization } from './license-paid-batch';
import type { VisibleOperation } from './license-workbench-operation.types';
import type { LicenseWorkflow } from './license-workflow';

import { licenseKeyDigest } from './license-eligibility';

export interface LicenseRerunSelection extends FreeSelection {
  operationId?: string;
  configurationRevision: number;
  contentRevision: number;
  estimateRevision?: number;
  cancel?: true;
  discardReviewedState?: boolean;
}

interface SelectedNotice {
  id: string;
  notice: string;
}

export class WorkbenchReassessment {
  revision = 0;
  scopeRevision = 0;
  private canceledModelId: string | null = null;
  private paid?: VisibleOperation;
  private sourceChange?: SelectedNotice & { outcome: 'retained' | 'closed' | 'replaced' };

  get visible() {
    return {
      estimateRevision: this.revision,
      reassessmentScopeRevision: this.scopeRevision,
      canceledModelId: this.canceledModelId,
      reassessmentSourceChange: this.sourceChange ?? null,
      selectedPaid: this.paid ?? null,
    };
  }

  acceptSourceChange(notice: SelectedNotice | null, outcome: 'retained' | 'closed' | 'replaced') {
    this.revision++;
    this.scopeRevision++;
    this.paid = undefined;
    this.sourceChange = notice ? { ...notice, outcome } : undefined;
    this.canceledModelId = notice && outcome !== 'retained' ? notice.id : null;
  }

  acceptSelection(selection: LicenseRerunSelection) {
    this.revision++;
    this.scopeRevision++;
    this.sourceChange = undefined;
    if (!selection.cancel || this.paid?.state !== 'succeeded') this.paid = undefined;
    this.canceledModelId = selection.cancel && selection.kind === 'model' ? selection.id : null;
  }

  async runPaid(
    workflow: LicenseWorkflow,
    authorization: PaidAuthorization,
    operation: VisibleOperation
  ) {
    const estimate = workflow.paidEstimate;
    operation.progress = {
      attempts: 0,
      completedRows: 0,
      totalRows: estimate?.outstanding.length ?? 0,
    };
    if (
      workflow.selectedModelId &&
      estimate?.outstanding.length &&
      estimate.fingerprint === authorization.fingerprint
    ) {
      const row = estimate.outstanding[0];
      operation.selectedModel = { id: row.id, notice: row.exampleNotice };
      this.paid = operation;
      this.sourceChange = undefined;
    }
    const analysis = await workflow.runPaid(authorization, operation.progress);
    const selected = operation.selectedModel;
    if (selected) {
      this.scopeRevision++;
      const item = analysis.artifact.classifications.find(
        (row) => licenseKeyDigest(row.normalizedText) === selected.id
      )!;
      Object.assign(selected, {
        decision: item.status,
        freshSamples: item.samples.filter((sample) => !sample.cacheHit).length,
        reusedSamples: item.samples.filter((sample) => sample.cacheHit).length,
      });
    }
  }
}

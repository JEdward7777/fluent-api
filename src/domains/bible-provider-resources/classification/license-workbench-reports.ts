import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { LicenseWorkflow } from './license-workflow';

import { licenseFileIo } from './license-write';

interface ReportPlan {
  id: string;
  configurationRevision: number;
  contentRevision: number;
  format: 'html' | 'markdown';
  path: string;
  previous: string | null;
  priorHash: string | null;
}

export class LicenseWorkbenchReports {
  private readonly plans = new Map<string, ReportPlan>();
  private readonly operations = new Map<
    string,
    {
      fingerprint: string;
      result: ReturnType<LicenseWorkflow['exportReport']>;
    }
  >();

  clear() {
    this.plans.clear();
  }

  async inspect(
    workflow: LicenseWorkflow,
    configurationRevision: number,
    body: Omit<ReportPlan, 'id' | 'previous' | 'priorHash'>
  ) {
    if (!workflow.previewed)
      throw new Error('Normal exact preview is required before report target inspection');
    if (workflow.status.state !== 'previewed')
      throw new Error('Wait for the current operation before inspecting a report target');
    if (
      body.configurationRevision !== configurationRevision ||
      body.contentRevision !== workflow.status.contentRevision
    )
      throw new Error('Stale report revision');
    const path = resolve(body.path);
    if (workflow.previewed.plan.expectedFiles.some((file) => file.path === path))
      throw new Error('Report target must differ from source and artifact paths');
    const previous = await licenseFileIo.read(path);
    const plan: ReportPlan = {
      ...body,
      path,
      id: randomUUID(),
      previous,
      priorHash: previous === null ? null : createHash('sha256').update(previous).digest('hex'),
    };
    this.plans.set(plan.id, plan);
    return {
      id: plan.id,
      path: plan.path,
      format: plan.format,
      existed: previous !== null,
      priorHash: plan.priorHash,
      configurationRevision: plan.configurationRevision,
      contentRevision: plan.contentRevision,
    };
  }

  export(
    workflow: LicenseWorkflow,
    configurationRevision: number,
    body: { planId: string; operationId: string; agreeToOverwrite: boolean }
  ) {
    const fingerprint = JSON.stringify([body.planId, body.agreeToOverwrite]);
    const prior = this.operations.get(body.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error('Report operation ID was reused with different arguments');
      return prior.result;
    }
    const plan = this.plans.get(body.planId);
    if (!plan) throw new Error('Inspect this report target before export');
    if (
      plan.configurationRevision !== configurationRevision ||
      plan.contentRevision !== workflow.status.contentRevision
    )
      throw new Error('Report plan is stale; inspect its target again');
    const result = workflow
      .exportReport({
        operationId: body.operationId,
        configurationRevision: workflow.status.configurationRevision,
        contentRevision: plan.contentRevision,
        format: plan.format,
        path: plan.path,
        expectedPreviousBytes: plan.previous,
        agreeToOverwrite: body.agreeToOverwrite,
      })
      .then((saved) => ({ ...saved, configurationRevision: plan.configurationRevision }));
    this.operations.set(body.operationId, { fingerprint, result });
    return result;
  }
}

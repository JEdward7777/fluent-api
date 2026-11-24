import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { LicenseWorkflow } from './license-workflow';

import { licenseFileIo } from './license-write';

interface ReportPlan {
  id: string;
  configurationRevision: number;
  contentRevision: number;
  format: 'html' | 'markdown';
  path: string;
  parent: string | undefined;
  previous: string | null;
  priorHash: string | null;
}

const reportParent = (path: string) => realpath(dirname(path)).catch(() => undefined);

async function reportEntryExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
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

  async exported(operationId: string) {
    return this.operations.get(operationId)?.result.catch(() => undefined);
  }

  clear() {
    this.plans.clear();
  }

  async inspect(
    workflow: LicenseWorkflow,
    configurationRevision: number,
    body: Omit<ReportPlan, 'id' | 'parent' | 'previous' | 'priorHash'>
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
    const [parent, previous] = await Promise.all([reportParent(path), licenseFileIo.read(path)]);
    if (previous === null && (await reportEntryExists(path)))
      throw new Error(
        'The report path already exists without readable report bytes. Choose a different path.'
      );
    const plan: ReportPlan = {
      ...body,
      path,
      parent,
      id: randomUUID(),
      previous,
      priorHash: previous === null ? null : createHash('sha256').update(previous).digest('hex'),
    };
    this.plans.set(plan.id, plan);
    return {
      id: plan.id,
      path: plan.path,
      parent: plan.parent,
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
    const result = (async () => {
      if ((await reportParent(plan.path)) !== plan.parent)
        throw new Error('The report target directory changed after inspection.');
      if (plan.previous === null && (await reportEntryExists(plan.path)))
        throw new Error('The report target appeared after inspection.');
      if (this.plans.get(plan.id) !== plan)
        throw new Error('Report plan is stale; inspect its target again');
      const saved = await workflow.exportReport({
        operationId: body.operationId,
        configurationRevision: workflow.status.configurationRevision,
        contentRevision: plan.contentRevision,
        format: plan.format,
        path: plan.path,
        expectedPreviousBytes: plan.previous,
        agreeToOverwrite: body.agreeToOverwrite,
      });
      return { ...saved, configurationRevision: plan.configurationRevision };
    })();
    this.operations.set(body.operationId, { fingerprint, result });
    return result;
  }
}

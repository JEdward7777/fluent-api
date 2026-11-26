import type { Hono } from 'hono';

import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import type { ReportDirectory } from './license-report-directory';
import type { LicenseWorkbenchSession } from './license-workbench-session';
import type { LicenseWorkflow } from './license-workflow';
import type { LicenseReportExportResult } from './license-workflow.types';

import { LICENSE_REPORT_HTML_CSP, renderLicenseHtml } from '../license-report-html';
import { renderLicenseMarkdown } from '../license-report-markdown';
import { inspectLicenseFile } from './license-file-identity';
import { inspectReportDirectory, requireReportDirectory } from './license-report-directory';
import { licenseSaveChanges } from './license-save-changes';
import { reportTargetChanged, reportTargetIdentity } from './license-workflow-report-export';
import { licenseFileIo } from './license-write';

interface ReportPlan {
  previewToken: string;
  id: string;
  configurationRevision: number;
  contentRevision: number;
  format: 'html' | 'markdown';
  path: string;
  directory: ReportDirectory;
  previous: string | null;
  priorHash: string | null;
  identity: string | null;
}

async function reportEntryExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

function readablePreview(workflow: LicenseWorkflow | undefined, token: string) {
  const preview =
    workflow?.status.state === 'previewed' ? workflow.previewed : workflow?.savedPreview;
  return preview?.token === token ? preview : undefined;
}

export class LicenseWorkbenchReports {
  private readonly plans = new Map<string, ReportPlan>();
  private readonly operations = new Map<
    string,
    {
      fingerprint: string;
      result: Promise<LicenseReportExportResult & { parent: string }>;
    }
  >();

  currentChanges(workflow: LicenseWorkflow | undefined, token: string, databaseLabel: string) {
    const preview = readablePreview(workflow, token);
    if (!preview || preview.plan.conflicts.length) return undefined;
    return licenseSaveChanges(preview, databaseLabel);
  }

  currentReport(
    workflow: LicenseWorkflow | undefined,
    practice: boolean,
    token: string,
    format: 'html' | 'markdown'
  ) {
    const preview = readablePreview(workflow, token);
    if (practice || !preview) return undefined;
    return format === 'html'
      ? renderLicenseHtml(preview.reports.model)
      : renderLicenseMarkdown(preview.reports.model);
  }

  async exported(operationId: string) {
    return this.operations.get(operationId)?.result.catch(() => undefined);
  }

  clear() {
    this.plans.clear();
  }

  async inspect(
    workflow: LicenseWorkflow,
    configurationRevision: number,
    body: Omit<ReportPlan, 'id' | 'directory' | 'previous' | 'priorHash' | 'identity'>
  ) {
    if (!workflow.previewed)
      throw new Error('Normal exact preview is required before report target inspection');
    if (!['saved', 'previewed'].includes(workflow.status.state))
      throw new Error('Wait for the current operation before inspecting a report target');
    if (
      body.previewToken !== workflow.previewed.token ||
      body.configurationRevision !== configurationRevision ||
      body.contentRevision !== workflow.status.contentRevision
    )
      throw new Error('Stale report revision');
    const path = resolve(body.path);
    if (workflow.previewed.plan.expectedFiles.some((file) => file.path === path))
      throw new Error('Report target must differ from source and artifact paths');
    const directory = await inspectReportDirectory(dirname(path));
    const identity = await reportTargetIdentity(path);
    const previous = await licenseFileIo.read(path);
    if (previous === null && (await reportEntryExists(path)))
      throw new Error(
        'The report path already exists without readable report bytes. Choose a different path.'
      );
    if (
      (identity === null) !== (previous === null) ||
      (await reportTargetIdentity(path)) !== identity
    )
      throw reportTargetChanged(path);
    const { canonical } = await inspectLicenseFile(path);
    if (workflow.previewed.plan.expectedFiles.some((file) => file.path === canonical))
      throw new Error('Report target must differ from source and artifact paths');
    await requireReportDirectory(dirname(path), directory);
    const plan: ReportPlan = {
      ...body,
      path,
      directory,
      id: randomUUID(),
      previous,
      identity,
      priorHash: previous === null ? null : createHash('sha256').update(previous).digest('hex'),
    };
    this.plans.set(plan.id, plan);
    return {
      id: plan.id,
      path: plan.path,
      parent: plan.directory.canonical,
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
      plan.previewToken !== workflow.previewed?.token ||
      plan.configurationRevision !== configurationRevision ||
      plan.contentRevision !== workflow.status.contentRevision
    )
      throw new Error('Report plan is stale; inspect its target again');
    const result = (async () => {
      await requireReportDirectory(dirname(plan.path), plan.directory);
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
        expectedReportIdentity: plan.identity,
        reportDirectory: plan.directory,
        agreeToOverwrite: body.agreeToOverwrite,
      });
      return {
        ...saved,
        parent: plan.directory.canonical,
        configurationRevision: plan.configurationRevision,
      };
    })().finally(() => this.plans.delete(plan.id));
    this.operations.set(body.operationId, { fingerprint, result });
    return result;
  }
}

export function registerReportViews(
  app: Hono,
  session: LicenseWorkbenchSession,
  authorized: (value: string) => boolean
) {
  app.get('/api/changes/:token', (c) => {
    const changes = session.currentChanges(c.req.param('token'));
    return changes
      ? c.json(changes)
      : c.text('The Save preview changed. Prepare a current preview.', 409);
  });
  const reportId = z.string().uuid();
  app.get('/api/current-report/:id/:format', (c) => {
    const format = z.enum(['html', 'markdown']).safeParse(c.req.param('format'));
    const bytes = format.success && session.currentReport(c.req.param('id'), format.data);
    if (!bytes) return c.text('The report preview changed.', 409);
    c.header('Content-Type', 'application/octet-stream');
    return c.body(bytes);
  });
  app.get('/api/report/:id', async (c) => {
    const id = reportId.safeParse(c.req.param('id'));
    const report = id.success ? await session.reports.exported(id.data) : undefined;
    if (!report) return c.text('Unknown exported report', 404);
    c.header('Content-Type', 'application/octet-stream');
    return c.body(report.bytes);
  });
  app.post('/report-view', async (c) => {
    if (c.req.header('origin') !== `http://${c.req.header('host')}`)
      return c.text('Local Origin required', 403);
    const parsed = z
      .object({ token: z.string(), id: reportId, current: z.literal('true').optional() })
      .strict()
      .safeParse(await c.req.parseBody().catch(() => null));
    if (!parsed.success || !authorized(parsed.data.token))
      return c.text('Session token required', 403);
    if (parsed.data.current) {
      const bytes = session.currentReport(parsed.data.id, 'html');
      if (!bytes) return c.text('The report preview changed.', 409);
      c.header('Content-Security-Policy', LICENSE_REPORT_HTML_CSP);
      return c.html(bytes);
    }
    const report = await session.reports.exported(parsed.data.id);
    if (!report) return c.text('Unknown exported report', 404);
    if (report.format === 'markdown') return c.text(report.bytes);
    c.header('Content-Security-Policy', LICENSE_REPORT_HTML_CSP);
    return c.html(report.bytes);
  });
}

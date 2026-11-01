import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';
import { LicenseWorkflow } from './license-workflow';

const fixtures: Awaited<ReturnType<typeof makeCommandFixture>>[] = [];
async function fixture() {
  const value = await makeCommandFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.cleanup()));
});

describe('license workflow operation lifecycle', () => {
  it('retains inspection and analysis results by operation ID without repeating reads', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow(f.options, f.dependencies);
    const inspectRequest = { operationId: 'inspect-1', configurationRevision: 1 };
    const inspected = await workflow.inspect(inspectRequest);
    expect(workflow.operation('inspect-1')).toMatchObject({
      state: 'succeeded',
      result: inspected,
    });
    const analyzed = await workflow.startAnalysis({
      operationId: 'analyze-1',
      configurationRevision: 1,
    });
    expect(await workflow.inspect(inspectRequest)).toEqual(inspected);
    expect(
      await workflow.startAnalysis({ operationId: 'analyze-1', configurationRevision: 1 })
    ).toEqual(analyzed);
    expect(workflow.operation('analyze-1')).toMatchObject({ state: 'succeeded', result: analyzed });
    expect(() => workflow.inspect({ ...inspectRequest, configurationRevision: 2 })).toThrow(
      'reused'
    );
    expect(() => workflow.startAnalysis(inspectRequest)).toThrow('reused');
    expect(f.dependencies.database).not.toHaveBeenCalled();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    await workflow.close();
  });

  it('stops before the next distinct model key and publishes no partial analysis', async () => {
    const f = await fixture();
    let workflow: LicenseWorkflow;
    const transport = vi.fn(async () => {
      workflow.requestStopAnalysis();
      return '{"rationale":"Permitted in this fixture.","decision":"allowed"}';
    });
    workflow = new LicenseWorkflow(
      { ...f.options, source: 'database' },
      { ...f.dependencies, transport }
    );
    await workflow.inspect({ operationId: 'inspect-db', configurationRevision: 1 });
    await expect(
      workflow.startAnalysis({ operationId: 'analysis-db', configurationRevision: 1 })
    ).rejects.toThrow('stopped');
    expect(workflow.status.state).toBe('inspected');
    expect(workflow.analyzed).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(f.options.sampleCount);
    expect(workflow.operation('analysis-db')).toMatchObject({ state: 'failed' });
    await workflow.close();
  });

  it('exports only an explicitly named report with destination freshness and deduplication', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow(f.options, f.dependencies);
    await workflow.inspect(1);
    await workflow.startAnalysis(1);
    await workflow.preview(1, 1);
    const path = join(f.dir, 'impact.md');
    const request = {
      operationId: 'report-1',
      configurationRevision: 1,
      contentRevision: 1,
      format: 'markdown' as const,
      path,
      expectedPreviousBytes: null,
      agreeToOverwrite: false,
    };
    const exported = await workflow.exportReport(request);
    const bytes = await readFile(path, 'utf8');
    expect(bytes).toContain('License');
    expect(await workflow.exportReport(request)).toEqual(exported);
    expect(workflow.operation('report-1')).toMatchObject({ state: 'succeeded', result: exported });
    expect(f.adapter.apply).not.toHaveBeenCalled();
    await expect(readFile(f.output, 'utf8')).rejects.toThrow();
    await writeFile(path, 'external change');
    await expect(workflow.exportReport({ ...request, operationId: 'report-2' })).rejects.toThrow(
      'changed'
    );
    expect(await readFile(path, 'utf8')).toBe('external change');
    await expect(
      workflow.exportReport({
        ...request,
        operationId: 'report-3',
        expectedPreviousBytes: 'external change',
      })
    ).rejects.toThrow('agreement');
    await workflow.close();
  });
});

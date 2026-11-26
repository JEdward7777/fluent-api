import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';
import * as preparation from './license-free-preparation';
import { LicenseWorkbenchSession } from './license-workbench-session';

vi.mock('./assets/review.js', () => ({ hasUnsavedReviewDraft: () => false }));

it('keeps the completed report and expanded changes through an estimate and closes them at a real receipt or preview boundary', async () => {
  const controls = new Map();
  const element = (id) => {
    if (!controls.has(id))
      controls.set(id, {
        value: '',
        elements: [],
        querySelector: () => element(`${id}-summary`),
        replaceChildren: vi.fn(),
        close() {
          this.open = false;
        },
      });
    return controls.get(id);
  };
  vi.stubGlobal('document', { getElementById: element });
  try {
    const { renderExactPreview } = await import('./assets/preview-ui.js');
    const receipt = {
      operationId: 'save-a',
      state: 'succeeded',
      result: { previewToken: 'preview-a' },
      configurationRevision: 3,
    };
    const saved = {
      state: 'saved',
      analysis: {},
      preview: { saved: true, token: 'preview-a', conflicts: [], targets: [] },
      configurationRevision: 3,
      sessionSave: receipt,
      saveOutcome: receipt,
    };
    const report = element('current-report');
    const drawer = element('changes-drawer');
    const records = element('changes-records');
    const exportButton = element('report-write');
    element('report-path').value = '/tmp/synthetic-report.md';
    for (const [next, flags] of [
      [{ ...saved, saveOutcome: { ...receipt, operationId: 'save-b' } }, {}],
      [{ ...saved, preview: { ...saved.preview, token: 'preview-b' } }, {}],
      [{ ...saved, configurationRevision: 4 }, {}],
      [{ ...saved, sourceChanged: true }, {}],
      [{ ...saved, activeOperationId: 'save-b' }, {}],
      [saved, { dirty: 'Output path' }],
      [saved, { savedViewBusy: true }],
    ]) {
      renderExactPreview(saved, {});
      expect(report.hidden).toBe(false);
      expect(element('view-changes').disabled).toBe(false);
      expect(exportButton.disabled).toBe(false);
      report.open = drawer.open = true;
      records.replaceChildren.mockClear();
      for (const state of ['saved', 'analyzing', 'saved']) {
        renderExactPreview(
          { ...saved, state },
          { settingsBusy: true, readiness: 'Waiting for estimate' }
        );
        expect(report.open).toBe(true);
        expect(report.hidden).toBe(false);
        expect(drawer.open).toBe(true);
        expect(element('view-changes').disabled).toBe(false);
        expect(records.replaceChildren).not.toHaveBeenCalled();
        expect(exportButton.disabled).toBe(true);
      }
      renderExactPreview(next, flags);
      expect(report.open).toBe(false);
      expect(report.hidden).toBe(true);
      expect(drawer.open).toBe(false);
      expect(records.replaceChildren).toHaveBeenCalledOnce();
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

it('serves the signed saved preview while a quote runs and still fences writes and obsolete tokens', async () => {
  const fixture = await makeCommandFixture();
  const session = new LicenseWorkbenchSession(fixture.options, false, fixture.dependencies);
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let quote;
  try {
    const configurationRevision = session.visible.configurationRevision;
    const load = session.start('inspect', {
      configurationRevision,
      operationId: crypto.randomUUID(),
    });
    await vi.waitFor(() => expect(session.operation(load.operationId).state).toBe('succeeded'));
    const { contentRevision } = session.visible;
    await session.preview(configurationRevision, contentRevision, false);
    const previewToken = session.visible.preview.token;
    const save = {
      configurationRevision,
      contentRevision,
      previewToken,
      operationId: crypto.randomUUID(),
      agreeToReplace: false,
    };
    session.save(save);
    await vi.waitFor(() => expect(session.operation(save.operationId).state).toBe('succeeded'));
    const receipt = session.visible.saveOutcome;
    expect(receipt.result).toMatchObject({ previewToken, incomplete: false });
    const changes = session.currentChanges(previewToken);
    const report = session.currentReport(previewToken, 'markdown');
    expect(report).toContain('#');
    const bytes = await readFile(fixture.output);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      changes.destinations[0].wholeFileHash
    );
    expect(JSON.parse(bytes).attestation).toEqual(fixture.artifact.attestation);
    const prepare = preparation.stageFreePreparation;
    vi.spyOn(preparation, 'stageFreePreparation').mockImplementationOnce(async (input) => {
      entered.resolve();
      await resume.promise;
      return prepare(input);
    });
    quote = session.refreshEstimate(session.visible);
    await entered.promise;
    expect(session.visible.state).toBe('analyzing');
    expect(session.visible.preview).toMatchObject({ saved: true, token: previewToken });
    expect(session.visible.saveOutcome).toEqual(receipt);
    expect(session.currentReport(previewToken, 'markdown')).toBe(report);
    expect(session.currentChanges(previewToken)).toEqual(changes);
    expect(() => session.save({ ...save, operationId: crypto.randomUUID() })).toThrow(/operation/);
    resume.resolve();
    await quote;
    expect(session.visible.state).toBe('saved');
    expect(session.currentReport(previewToken, 'markdown')).toBe(report);
    await session.configure({
      ...session.visible,
      output: `${fixture.output}.next`,
      discardReviewedState: false,
    });
    expect(session.currentReport(previewToken, 'markdown')).toBeUndefined();
    expect(session.currentChanges(previewToken)).toBeUndefined();
    expect(() => session.save({ ...save, operationId: crypto.randomUUID() })).toThrow(/Stale/);
    expect(fixture.dependencies.transport).not.toHaveBeenCalled();
  } finally {
    resume.resolve();
    await quote;
    vi.restoreAllMocks();
    await session.close();
    await fixture.cleanup();
  }
});

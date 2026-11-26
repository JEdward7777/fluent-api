import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { olderSetup } from './assets/estimate-refresh.js';
import { makeCommandFixture } from './license-command.test-fixtures';
import { LicenseWorkbenchSession } from './license-workbench-session';

it('ignores a late preview or pre-Save read at the same configuration and content revision', () => {
  const saved = { loadRevision: 2, configurationRevision: 3, contentRevision: 4, stateRevision: 9 };
  expect(olderSetup(saved, { ...saved, stateRevision: 8 })).toBe(true);
  expect(olderSetup(saved, { ...saved, stateRevision: 10 })).toBe(false);
  expect(olderSetup(saved, { ...saved, loadRevision: 3, stateRevision: 1 })).toBe(false);
});

function browserControls() {
  const storage = new Map();
  const controls = new Map();
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  });
  vi.stubGlobal('document', {
    getElementById(id) {
      if (!controls.has(id))
        controls.set(id, {
          addEventListener(event, callback) {
            this[event] = callback;
          },
        });
      return controls.get(id);
    },
  });
  return { controls, storage };
}

it.each([
  { practice: false, failFirst: false },
  { practice: false, failFirst: true },
  { practice: true, failFirst: false },
  { practice: true, failFirst: true },
])(
  'publishes the new preview after another tab supersedes a delayed Save (practice $practice, failed first $failFirst)',
  async ({ practice, failFirst }) => {
    const f = await makeCommandFixture(false);
    const session = new LicenseWorkbenchSession(f.options, practice, f.dependencies);
    const scratch = new Set();
    const { controls, storage } = browserControls();
    vi.resetModules();
    const { initSave, renderSave, saveStatusUnconfirmed, withTabSaveOutcome } =
      await import('./assets/save.js');
    const delayed = Promise.withResolvers();
    const submissions = [];
    const lookups = [];
    const submit = (body) => (practice ? session.savePractice(body) : session.save(body));
    async function prepare(index) {
      if (index) {
        const input = join(f.dir, `source-${index}.json`);
        await writeFile(input, f.sourceBytes);
        const current = session.visible;
        await session.configure({
          ...f.options,
          configurationRevision: current.configurationRevision,
          input,
          output: practice ? current.output : join(f.dir, `output-${index}.json`),
          model: current.model,
          sampleCount: current.sampleCount,
          cacheDir: current.cacheDir,
          reportDir: current.reportDir,
          reportFormats: current.reportFormats,
          discardReviewedState: false,
        });
      }
      for (const kind of ['inspect', 'analysis']) {
        const op = session.start(kind, {
          discardReviewedState: Boolean(index),
          expectedContentRevision: session.visible.contentRevision,
          configurationRevision: session.visible.configurationRevision,
          operationId: crypto.randomUUID(),
        });
        await vi.waitFor(() => expect(session.operation(op.operationId)?.state).toBe('succeeded'));
      }
      if (session.visible.scratch) scratch.add(session.visible.scratch);
      const { configurationRevision, contentRevision } = session.visible;
      await session.preview(configurationRevision, contentRevision, practice);
      return {
        configurationRevision,
        contentRevision,
        previewToken: session.visible.preview.token,
        operationId: crypto.randomUUID(),
        ...(!practice && { agreeToReplace: false }),
      };
    }
    try {
      await prepare(0);
      let setup;
      const refresh = () => {
        setup = withTabSaveOutcome(session.visible);
        renderSave(setup);
      };
      const firstPath = session.visible.output;
      if (failFirst) await writeFile(firstPath, 'external bytes');
      initSave({
        getSetup: () => setup,
        refresh,
        recover: vi.fn(),
        hasDraft: () => false,
        isBlocked: () => false,
        setPracticeBusy: vi.fn(),
        async request(path, method, body) {
          if (method !== 'POST') {
            const id = path.split('/').at(-1);
            lookups.push(id);
            return session.operation(id);
          }
          submissions.push(body);
          const op = await submit(body);
          if (submissions.length === 1) await delayed.promise;
          return op;
        },
      });
      refresh();
      const button = controls.get(practice ? 'practice-save' : 'normal-save-button');
      button.click();
      const firstId = submissions[0].operationId;
      await vi.waitFor(() =>
        expect(session.operation(firstId)?.state).toBe(failFirst ? 'failed' : 'succeeded')
      );
      const otherTab = await prepare(1);
      await submit(otherTab);
      await vi.waitFor(() =>
        expect(session.operation(otherTab.operationId)?.state).toBe('succeeded')
      );
      expect(session.visible.saveOutcome.operationId).toBe(otherTab.operationId);
      delayed.resolve();
      await vi.waitFor(() => {
        expect(lookups).toContain(firstId);
        expect(storage.has('license-workbench-pending-save')).toBe(false);
        const result = controls.get('save-result');
        expect(result.textContent).toContain(firstId);
        expect(result.textContent).not.toContain(otherTab.operationId);
        expect(result.textContent).toContain(
          failFirst ? session.operation(firstId).error : firstPath
        );
        expect(saveStatusUnconfirmed()).toBe(false);
      });
      const latest = await prepare(2);
      refresh();
      button.click();
      expect(submissions).toHaveLength(2);
      const last = submissions[1];
      expect(last.previewToken).toBe(latest.previewToken);
      expect(last.operationId).not.toBe(firstId);
      await vi.waitFor(() => expect(session.operation(last.operationId)?.state).toBe('succeeded'));
      refresh();
      button.click();
      expect(submissions).toHaveLength(2);
      expect(
        JSON.parse(await readFile(session.visible.output, 'utf8')).classifications
      ).toHaveLength(3);
    } finally {
      delayed.resolve();
      await session.close();
      await Promise.all([...scratch].map((dir) => rm(dir, { recursive: true, force: true })));
      await f.cleanup();
      vi.unstubAllGlobals();
    }
  }
);

it.each([false, true])(
  'keeps the practice rejection visible after a recovery read (available %s)',
  async (available) => {
    const { controls, storage } = browserControls();
    vi.resetModules();
    try {
      const { initSave } = await import('./assets/save.js');
      let confirmed = true;
      let status = '';
      const rejected = Object.assign(new Error('Stale preview token'), { requestRejected: true });
      const setup = { state: 'previewed', preview: { token: 'old' }, launchId: 'session' };
      const request = vi.fn(async (path) => {
        if (path === 'practice/save') throw rejected;
        if (path.startsWith('operations/'))
          throw Object.assign(new Error('Unknown operation'), { status: 404 });
        if (!available) throw new Error('Unavailable');
        return { ...setup, preview: { token: 'fresh' } };
      });
      const render = vi.fn((next) => {
        confirmed = true;
        status = 'Practice ready';
        Object.assign(setup, next);
      });
      const busy = vi.fn();
      initSave({
        request,
        getSetup: () => setup,
        isBlocked: () => !confirmed,
        hasDraft: () => false,
        setPracticeBusy: busy,
        // This mirrors the page's confirmed-setup and failure branches. A cached render after
        // either branch would erase the rejection and unlock an unconfirmed session.
        render,
        async recover(message) {
          try {
            render(await request('setup'));
            status = message;
          } catch {
            confirmed = false;
            status = `${message} — session unavailable`;
          }
        },
      });
      const button = controls.get('practice-save');
      button.click();
      await vi.waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
      expect(status).toContain('Stale preview token');
      expect(confirmed).toBe(available);
      expect(setup.preview.token).toBe(available ? 'fresh' : 'old');
      expect(storage.has('license-workbench-pending-save')).toBe(false);
      expect(request.mock.calls.map(([path]) => path.split('/')[0])).toEqual([
        'practice',
        'operations',
        'setup',
      ]);
      if (!available) {
        button.click();
        expect(request).toHaveBeenCalledTimes(3);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  }
);

it.each([
  { practice: false, rejected: true },
  { practice: true, rejected: true },
  { practice: false, rejected: false },
  { practice: true, rejected: false },
])(
  'reconciles a missing operation after a transient lookup and reload (practice $practice, rejected $rejected)',
  async ({ practice, rejected }) => {
    const { controls, storage } = browserControls();
    const bodies = [];
    let reloaded = false;
    let settled = false;
    let lookups = 0;
    let saveOutcome = null;
    const key = 'license-workbench-pending-save';
    const initial = {
      practice,
      launchId: 'session',
      state: 'previewed',
      preview: { token: 'old', targets: [] },
    };
    let setup = initial;
    try {
      async function open() {
        vi.resetModules();
        const ui = await import('./assets/save.js');
        const refresh = () => {
          setup = ui.withTabSaveOutcome({
            ...initial,
            saveOutcome,
            preview: { token: reloaded ? 'new' : 'old' },
          });
          ui.renderSave(setup);
        };
        ui.initSave({
          getSetup: () => setup,
          refresh,
          recover: refresh,
          isBlocked: () => false,
          hasDraft: () => false,
          setPracticeBusy: vi.fn(),
          async request(path, method, body) {
            if (method === 'POST') {
              bodies.push(body);
              if (bodies.length === 1)
                throw Object.assign(new Error(rejected ? 'Stale token' : 'Response lost'), {
                  requestRejected: rejected,
                });
              saveOutcome = {
                operationId: body.operationId,
                kind: 'save',
                state: 'succeeded',
                result: { targets: [], wholeFileHash: 'new hash', policy: null },
              };
              return saveOutcome;
            }
            lookups++;
            if (reloaded) settled = true;
            throw Object.assign(new Error(path), { status: reloaded ? 404 : 503 });
          },
        });
        refresh();
        return ui;
      }
      await open();
      const button = controls.get(practice ? 'practice-save' : 'normal-save-button');
      button.click();
      await vi.waitFor(() =>
        expect(JSON.parse(storage.get(key)).rejection).toBe(rejected ? 'Stale token' : undefined)
      );
      await vi.waitFor(() => expect(lookups).toBeGreaterThanOrEqual(2));
      reloaded = true;
      const ui = await open();
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(ui.saveStatusUnconfirmed()).toBe(!rejected);
      expect(storage.has(key)).toBe(!rejected);
      button.click();
      if (rejected) {
        expect(bodies).toHaveLength(2);
        expect(bodies[1].operationId).not.toBe(bodies[0].operationId);
        expect(bodies[1].previewToken).toBe('new');
        await vi.waitFor(() =>
          expect(controls.get('save-result').textContent).toContain(bodies[1].operationId)
        );
      } else expect(bodies).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  }
);

it('reconciles the session-wide uncertain Save while retaining the originating tab receipt', async () => {
  const { controls, storage } = browserControls();
  try {
    vi.resetModules();
    const ui = await import('./assets/save.js');
    const receipt = {
      launchId: 'launch',
      operation: { operationId: 'A', state: 'succeeded', result: { targets: [], policy: null } },
    };
    storage.set('license-workbench-save-receipt', JSON.stringify(receipt));
    const server = {
      launchId: 'launch',
      state: 'uncertain',
      saveOutcome: { operationId: 'B', state: 'failed', error: 'Unknown commit' },
    };
    let setup;
    const refresh = () => {
      setup = ui.withTabSaveOutcome(server);
      ui.renderSave(setup);
    };
    const request = vi.fn(async () => {
      server.state = 'reviewing';
      server.saveOutcome.reconciliation = { outcome: 'prior', targets: [] };
      return server.saveOutcome;
    });
    ui.initSave({
      getSetup: () => setup,
      refresh,
      request,
      isBlocked: () => false,
      hasDraft: () => false,
    });
    refresh();
    const button = controls.get('reconcile-save');
    expect(button.hidden).toBe(false);
    expect(controls.get('session-save-status').textContent).toContain(
      'Session Save B is uncertain'
    );
    expect(controls.get('save-result').textContent).toContain('Operation A');
    await button.click({ currentTarget: button });
    expect(request).toHaveBeenCalledWith('save/reconcile', 'POST', { operationId: 'B' });
    expect(button.hidden).toBe(true);
    expect(controls.get('session-save-status').textContent).toContain('confirmed unwritten');
    expect(controls.get('save-result').textContent).toContain('Operation A');
    expect(JSON.parse(storage.get('license-workbench-save-receipt'))).toEqual(receipt);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('allows source comparison while a failed preview blocks Save', async () => {
  const { controls } = browserControls();
  vi.resetModules();
  try {
    const { initSave } = await import('./assets/save.js');
    const request = vi.fn().mockRejectedValue(new Error('Source currently unavailable'));
    let busy = true;
    initSave({ request, isBlocked: () => true, canReconcileSource: () => !busy });
    await controls.get('source-inspect').click();
    expect(request).not.toHaveBeenCalled();
    busy = false;
    await controls.get('source-inspect').click();
    expect(request).toHaveBeenCalledExactlyOnceWith('source/reconcile', 'POST', {});
    expect(controls.get('source-resolution-status').textContent).toBe(
      'Source currently unavailable'
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

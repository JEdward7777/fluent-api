import { describe, expect, it, vi } from 'vitest';

import {
  createAnalysisProgress,
  evidenceActions,
  inspectionSummary,
  workflowStatus,
} from './assets/analysis-progress.js';
import { licenseWorkbenchPreviewLines } from './assets/preview-text.js';
import { reassessmentStatus } from './assets/review-rerun.js';
import {
  populateConnection,
  roleConnectionDrafts,
  syncSettingsFields,
} from './assets/settings-draft.js';

describe('database role presentation', () => {
  it('renders the loaded source and preview destination even when the setup draft changed', () => {
    const text = licenseWorkbenchPreviewLines({
      source: 'json',
      input: 'unloaded-source.json',
      databaseTarget: 'unloaded-db',
      preview: {
        sourceLabel: 'source-db',
        destinationDatabaseLabel: 'destination-db',
        targets: [],
      },
    }).join('\n');
    expect(text).toContain('Source: source-db.');
    expect(text).toContain('Destination: destination-db.');
    expect(text).not.toContain('unloaded');
  });

  it.each([true, false])(
    'rebases a clean destination default and retains typed changes (active %s)',
    (active) => {
      const environment = { mode: 'environment' };
      let setup = {
        reportFormats: 'none',
        destinationConnectionRevision: 1,
        sourceRevision: 1,
        destinationRevision: 1,
        sourceDatabaseConnection: environment,
        destinationDatabaseConnection: environment,
      };
      const connection = {
        mode: 'session',
        host: 'copied-host',
        port: 5432,
        database: 'copied-db',
        username: 'reader',
        tls: 'verify-full',
        passwordRetained: true,
      };
      const elements = Object.fromEntries(
        ['Mode', 'Host', 'Port', 'Name', 'Username', 'Tls', 'Password', 'ClearPassword'].map(
          (name) => [`database${name}`, {}]
        )
      );
      let change;
      elements.databaseRole = {
        value: 'source',
        addEventListener: (_, callback) => {
          change = callback;
        },
      };
      const form = { elements };
      const database = {
        invalidate: vi.fn(),
        syncFields: vi.fn(),
        read: () => ({
          mode: elements.databaseMode.value,
          host: elements.databaseHost.value,
          port: elements.databasePort.value,
          database: elements.databaseName.value,
          username: elements.databaseUsername.value,
          tls: elements.databaseTls.value,
          password: elements.databasePassword.value,
        }),
      };
      populateConnection(form, environment);
      const drafts = roleConnectionDrafts(form, database, () => setup, vi.fn());
      function select(role) {
        elements.databaseRole.value = role;
        change();
      }
      function refresh(connection) {
        const next = {
          ...setup,
          destinationRevision: setup.destinationRevision + 1,
          destinationConnectionRevision: setup.destinationConnectionRevision + 1,
          destinationDatabaseConnection: connection,
        };
        drafts.rebase(setup, next);
        setup = next;
      }
      select('destination');
      if (!active) select('source');
      refresh(connection);
      if (!active) select('destination');
      expect(elements.databaseName.value).toBe('copied-db');
      expect(elements.databasePassword.value).toBe('');
      elements.databaseName.value = 'typed-db';
      if (!active) select('source');
      refresh({ ...connection, database: 'server-db' });
      if (!active) select('destination');
      expect(elements.databaseName.value).toBe('typed-db');
      expect(drafts.conflict).toContain('destination database connection changed in another tab');
      for (const name of [
        'destination',
        'output',
        'reportFormats',
        'reportDir',
        'force',
        'preserve',
      ])
        elements[name] = {};
      drafts.restore('save');
      expect(elements.databaseName.value).toBe('server-db');
      expect(drafts.conflict).toBe('');
    }
  );
});

it.each(['reviewing', 'saved'])(
  'announces the latest replacement Inspect result over retained %s status',
  (state) => {
    const view = { state, analysis: { rows: 4 } };
    const failed = {
      kind: 'inspect',
      state: 'failed',
      error: 'Invalid JSON source.',
      cleanupWarning: 'Pool cleanup failed.',
    };
    expect(workflowStatus({ ...view, latestOperation: failed }, {})).toBe(
      'Invalid JSON source. Pool cleanup failed.'
    );
    const succeeded = {
      kind: 'inspect',
      state: 'succeeded',
      cleanupWarning: 'Pool cleanup failed.',
    };
    expect(workflowStatus({ ...view, latestOperation: succeeded }, {})).toBe(
      'Loaded the selected source. Pool cleanup failed.'
    );
  }
);

it.each([
  ['analysis', 'Preparing free evidence…'],
  ['paid', 'Running paid classification…'],
])('announces active and failed %s over available review rows', (kind, message) => {
  const view = { state: 'reviewing', analysis: { rows: 4 } };
  expect(workflowStatus({ ...view, latestOperation: { kind, state: 'running' } }, {})).toBe(
    message
  );
  const failure = { kind, state: 'failed', error: 'Fixture operation failed.' };
  expect(workflowStatus({ ...view, latestOperation: failure }, {})).toBe(failure.error);
});

function settingsForm() {
  const form = { elements: {} };
  for (const name of [
    'source',
    'destination',
    'input',
    'output',
    'model',
    'samples',
    'cacheDir',
    'reportFormats',
    'reportDir',
    'force',
    'noCache',
    'preserve',
    'databaseMode',
    'databaseHost',
    'databasePort',
    'databaseName',
    'databaseUsername',
    'databaseTls',
    'databasePassword',
    'databaseClearPassword',
    'discardReviewedState',
  ])
    form.elements[name] = {
      value: '',
      closest: () => ({ dataset: { stage: ['source', 'input'].includes(name) ? 'load' : 'save' } }),
      type: ['force', 'noCache', 'preserve'].includes(name)
        ? 'checkbox'
        : name === 'samples'
          ? 'number'
          : 'text',
    };
  form.elements.databaseRole = { value: 'source', addEventListener: vi.fn() };
  return form;
}

it('merges another tab’s pristine settings without clearing the active source test or local edits', () => {
  const form = settingsForm();
  const environment = { mode: 'environment' };
  const prior = {
    configurationRevision: 1,
    sourceRevision: 1,
    destinationRevision: 1,
    source: 'json',
    destination: 'json',
    input: 'a.json',
    output: 'one.json',
    model: 'google:test',
    sampleCount: 2,
    reportFormats: 'none',
    sourceDatabaseConnection: environment,
    destinationDatabaseConnection: environment,
  };
  const database = { read: () => environment, invalidate: vi.fn() };
  const drafts = roleConnectionDrafts(form, database, () => prior, vi.fn());
  drafts.refresh(undefined, prior, true);
  form.elements.samples.value = '4';
  const next = { ...prior, configurationRevision: 2, destinationRevision: 2, output: 'two.json' };
  drafts.refresh(prior, next, false);
  expect(database.invalidate.mock.calls).toEqual([['destination']]);
  expect(drafts.readDraft()).toMatchObject({ output: 'two.json', sampleCount: 4 });
  drafts.refresh(next, { ...next, sourceRevision: 2 }, false);
  expect(database.invalidate.mock.calls).toEqual([['destination'], ['source']]);
});

it.each([false, true])(
  'recognizes its own source publication only at its exact source revision (superseded %s)',
  (superseded) => {
    const form = settingsForm();
    const env = { mode: 'environment' };
    const initial = {
      source: 'database',
      reportFormats: 'none',
      configurationRevision: 1,
      sourceRevision: 1,
      sourceConnectionRevision: 1,
      loadRevision: 1,
      sourceDatabaseConnection: env,
      destinationDatabaseConnection: env,
    };
    const db = {
      read: () => ({
        mode: form.elements.databaseMode.value,
        host: form.elements.databaseHost.value,
        password: form.elements.databasePassword.value,
      }),
      invalidate: vi.fn(),
    };
    let current = initial;
    const drafts = roleConnectionDrafts(form, db, () => current, vi.fn());
    drafts.refresh(undefined, current, true);
    form.elements.databaseMode.value = 'session';
    form.elements.databaseHost.value = 'first';
    form.elements.databasePassword.value = 'entered-secret';
    drafts.submitLoad('mine');
    const connection = {
      mode: 'session',
      host: superseded ? 'other' : 'first',
      passwordRetained: true,
    };
    const publishing = {
      ...initial,
      configurationRevision: 2,
      sourceRevision: superseded ? 3 : 2,
      sourceConnectionRevision: 2,
      loadRevision: 2,
      sourceDatabaseConnection: connection,
      lastSourceLoad: { operationId: 'mine', sourceRevision: 2 },
      latestOperation: { operationId: 'mine', state: superseded ? 'succeeded' : 'running' },
    };
    drafts.refresh(current, publishing, false);
    current = publishing;
    expect(drafts.conflicted('source')).toBe(superseded);
    expect(form.elements.databasePassword.value).toBe(superseded ? 'entered-secret' : '');
    form.elements.databaseHost.value = 'newer-local-draft';
    drafts.refresh(
      current,
      { ...publishing, latestOperation: { operationId: 'mine', state: 'succeeded' } },
      false
    );
    expect(form.elements.databaseHost.value).toBe('newer-local-draft');
  }
);

it.each([
  [
    { state: 'inspected', practice: true, readyForInspect: true, analysis: null },
    { inspect: true, analyze: true },
  ],
  [
    { state: 'reviewing', readyForInspect: true, sourceDraftPending: true },
    { inspect: true, analyze: false },
  ],
  [
    { state: 'inspected', readyForInspect: true, sourceDraftPending: false },
    { inspect: false, analyze: true },
  ],
])(
  'blocks both starts while a row edit is local and restores the eligible action after resolution',
  (setup, eligible) => {
    expect(evidenceActions(setup, false, {}, true)).toEqual({ inspect: false, analyze: false });
    expect(evidenceActions(setup, false, {}, false)).toEqual(eligible);
  }
);

it('permits a pending source replacement with unapplied AI settings and blocks free refresh', () => {
  const changes = { load: '', analysis: 'samples' };
  expect(
    evidenceActions(
      { state: 'reviewing', readyForInspect: true, sourceDraftPending: true },
      false,
      changes,
      false
    )
  ).toEqual({ inspect: true, analyze: false });
  expect(
    evidenceActions(
      { state: 'reviewing', readyForInspect: true, sourceDraftPending: false },
      false,
      changes,
      false
    )
  ).toEqual({ inspect: false, analyze: false });
});

it.each(['configuring', 'reviewing'])(
  'shows the active candidate load over the published %s state',
  (state) => {
    const actions = { setAttribute: vi.fn() };
    const spinner = {};
    const label = {};
    vi.stubGlobal('document', {
      getElementById: (id) => (id === 'analysis-actions' ? actions : label),
      querySelector: () => spinner,
    });
    try {
      const progress = createAnalysisProgress(vi.fn(), vi.fn(), () => false);
      const operation = { kind: 'inspect', state: 'running', operationId: 'loading' };
      const setup = { state, activeOperationId: 'loading', latestOperation: operation };
      progress.update(setup);
      expect(actions.setAttribute).toHaveBeenLastCalledWith('aria-busy', 'true');
      expect(spinner.hidden).toBe(false);
      expect(label.textContent).toMatch(/Loading source/);
      progress.update({ ...setup, activeOperationId: 'different' });
      expect(actions.setAttribute).toHaveBeenLastCalledWith('aria-busy', 'false');
      expect(spinner.hidden).toBe(true);
      expect(label.textContent).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  }
);

it.each(['inspect', 'analysis'])(
  'locks %s synchronously through acknowledgement and status recovery',
  async (kind) => {
    const control = { setAttribute: vi.fn() };
    vi.stubGlobal('document', { getElementById: () => control, querySelector: () => control });
    try {
      const setup = {};
      const renders = [];
      const progress = createAnalysisProgress(
        () => setup,
        () => renders.push(progress.starting),
        () => false
      );
      for (const fails of [false, true]) {
        const response = Promise.withResolvers();
        const status = Promise.withResolvers();
        const recover = vi.fn(() => status.promise);
        const run = progress.start(
          kind,
          async () => {
            await response.promise;
            if (fails) throw new Error('fixture rejection');
            await status.promise;
          },
          recover
        );
        expect(progress.starting).toBe(kind);
        expect(renders.at(-1)).toBe(kind);
        response.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(progress.starting).toBe(kind);
        expect(recover).toHaveBeenCalledTimes(fails ? 1 : 0);
        status.resolve();
        if (fails) await expect(run).rejects.toThrow('fixture rejection');
        else await run;
        expect(progress.starting).toBeNull();
        expect(renders.at(-1)).toBeNull();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  }
);

it.each([false, true])(
  'locks all setup inputs during Apply and restores their eligibility (practice %s)',
  (practice) => {
    const fields = ['input', 'output', 'model', 'samples', 'databaseRole', 'databasePassword'].map(
      (name) => ({ name })
    );
    const form = { elements: fields };
    syncSettingsFields(form, true, practice);
    expect(fields.every((field) => field.disabled)).toBe(true);
    syncSettingsFields(form, false, practice);
    expect(fields.filter((field) => field.disabled).map((field) => field.name)).toEqual(
      practice ? ['output', 'model', 'samples'] : []
    );
  }
);

it('renders only the current free preparation estimate and enables refreshing a loaded review', () => {
  const view = {
    state: 'reviewing',
    contentRevision: 2,
    inspected: {
      inspectedAt: 'fixture time',
      preflight: { distinctKeys: 3, expectedUncachedRequests: 99 },
    },
    paidEstimate: {
      contentRevision: 2,
      expectedUncachedRequests: 2,
      maximumAttempts: 10,
      provider: 'google',
      model: 'fixture',
      sampleCount: 3,
      replacements: [],
      cost: { reason: 'Pricing unavailable.' },
    },
  };
  expect(inspectionSummary(view, false)).toContain(
    'revision 2. 2 outstanding model requests, up to 10 attempts'
  );
  expect(inspectionSummary({ ...view, contentRevision: 3 }, false)).toContain(
    'refreshed automatically'
  );
  expect(inspectionSummary(view, true)).toContain('current AI settings');
  expect(
    inspectionSummary(
      { ...view, paidEstimate: { ...view.paidEstimate, expectedUncachedRequests: 0 } },
      false
    )
  ).toContain('0 outstanding model requests. No AI work needed.');
  expect(evidenceActions(view, false, {}, false).analyze).toBe(true);
});

it('reports the rule nonmatch in both the immediate acknowledgement and the current estimate', () => {
  const selection = { id: 'selected', kind: 'rule' };
  const estimate = {
    contentRevision: 7,
    selection,
    unmatchedRuleIds: [selection.id],
    expectedUncachedRequests: 0,
    replacements: [],
  };
  const message = 'No rule matched the selected notice. Its decision was kept.';
  expect(reassessmentStatus(selection, estimate)).toBe(message);
  expect(
    inspectionSummary(
      {
        contentRevision: 7,
        paidEstimate: estimate,
        inspected: { inspectedAt: 'fixture time', preflight: { distinctKeys: 4 } },
      },
      false
    )
  ).toContain(message);
});

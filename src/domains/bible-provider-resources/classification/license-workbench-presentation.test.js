import { describe, expect, it, vi } from 'vitest';

import {
  createAnalysisProgress,
  evidenceActions,
  workflowStatus,
} from './assets/analysis-progress.js';
import { licenseWorkbenchPreviewLines } from './assets/preview-text.js';
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
      drafts.reset();
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

it('merges another tab’s pristine settings without clearing the active source test or local edits', () => {
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
      type: ['force', 'noCache', 'preserve'].includes(name)
        ? 'checkbox'
        : name === 'samples'
          ? 'number'
          : 'text',
    };
  form.elements.databaseRole = { value: 'source', addEventListener: vi.fn() };
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
  expect(database.invalidate).not.toHaveBeenCalled();
  expect(drafts.readDraft()).toMatchObject({ output: 'two.json', sampleCount: 4 });
  drafts.refresh(next, { ...next, sourceRevision: 2 }, false);
  expect(database.invalidate).toHaveBeenCalledOnce();
});

it.each([
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
    expect(evidenceActions(setup, false, false, true)).toEqual({ inspect: false, analyze: false });
    expect(evidenceActions(setup, false, false, false)).toEqual(eligible);
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

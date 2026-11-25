import { access, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';
import * as database from './license-workbench-database';
import { LicenseWorkbenchSession } from './license-workbench-session';

it('fences row mutations, reassessment and report plans across a successful source replacement', async () => {
  const fixture = await makeCommandFixture(false);
  const session = new LicenseWorkbenchSession(fixture.options, false, fixture.dependencies);
  const load = async () => {
    const { operationId } = session.start('inspect', {
      configurationRevision: session.visible.configurationRevision,
      operationId: crypto.randomUUID(),
      discardReviewedState: true,
      expectedContentRevision: session.visible.contentRevision,
    });
    await vi.waitFor(() => expect(session.operation(operationId)?.state).toBe('succeeded'));
  };
  try {
    await load();
    const secondSource = join(fixture.dir, 'second.json');
    await writeFile(secondSource, fixture.sourceBytes);
    const view = session.visible;
    await session.configure({
      ...fixture.options,
      configurationRevision: view.configurationRevision,
      source: 'json',
      destination: 'json',
      cacheDir: view.cacheDir,
      reportDir: view.reportDir,
      input: secondSource,
      reportFormats: 'none',
      discardReviewedState: false,
    });
    const first = session.listReview({ search: '', status: 'all', source: 'all', page: 1 });
    const row = first.rows[0];
    const revision = {
      configurationRevision: first.configurationRevision,
      contentRevision: first.contentRevision,
    };
    await expect(
      session.selectRerun({ ...revision, id: row.id, kind: 'model', discardReviewedState: true })
    ).rejects.toThrow('restore the loaded source');
    expect(session.visible.loadedSource?.input).toBe(fixture.input);
    expect(session.visible.input).toBe(secondSource);
    expect(session.reviewDetail(row.id).status).toBe(row.status);
    await session.preview(revision.configurationRevision, revision.contentRevision);
    const report = await session.inspectReport({
      ...revision,
      format: 'markdown',
      path: join(fixture.dir, 'impact.md'),
    });
    await load();
    expect(session.visible.loadedSource?.input).toBe(secondSource);
    expect(session.visible.contentRevision).toBe(revision.contentRevision);
    expect(session.visible.configurationRevision).toBeGreaterThan(revision.configurationRevision);
    expect(() =>
      session.editReview({
        ...revision,
        id: row.id,
        acknowledgeWarning: true,
        edit: {
          kind: 'disposition',
          normalizedText: row.normalizedText,
          status: 'unknown',
          reason: 'Stale A edit',
          reviewedBy: 'Fixture reviewer',
        },
      })
    ).toThrow('Stale configuration');
    expect(session.reviewDetail(row.id).status).toBe(row.status);
    await expect(
      session.exportReport({
        planId: report.id,
        operationId: crypto.randomUUID(),
        agreeToOverwrite: false,
      })
    ).rejects.toThrow('Inspect this report target');
    expect(fixture.dependencies.transport).not.toHaveBeenCalled();
  } finally {
    await session.close();
    await fixture.cleanup();
  }
});

const sessionConnection = {
  mode: 'session' as const,
  host: 'localhost',
  port: 5432,
  database: 'source-fixture',
  username: 'fixture-reader',
  password: 'fixture-secret',
  clearPassword: false,
  tls: 'verify-full' as const,
};

it.each(['json', 'database'] as const)(
  'keeps the loaded %s identity when an inactive source setting changes',
  async (source) => {
    const fixture = await makeCommandFixture(false);
    const session = new LicenseWorkbenchSession(
      { ...fixture.options, source },
      false,
      fixture.dependencies
    );
    try {
      const initial = session.start('inspect', {
        operationId: crypto.randomUUID(),
        configurationRevision: 1,
      });
      await vi.waitFor(() =>
        expect(session.operation(initial.operationId)?.state).toBe('succeeded')
      );
      const loaded = session.visible;
      const changed = await session.configure({
        ...fixture.options,
        source,
        destination: 'json',
        reportFormats: 'none',
        cacheDir: loaded.cacheDir,
        reportDir: loaded.reportDir,
        configurationRevision: loaded.configurationRevision,
        discardReviewedState: true,
        ...(source === 'database'
          ? { input: join(fixture.dir, 'unused-path.json') }
          : { sourceDatabaseConnection: sessionConnection }),
      });
      expect(changed).toMatchObject({
        sourceDraftPending: false,
        loadRevision: loaded.loadRevision,
        sourceRevision: loaded.sourceRevision + (source === 'json' ? 1 : 0),
      });
      expect(() =>
        session.start('inspect', {
          operationId: crypto.randomUUID(),
          configurationRevision: changed.configurationRevision,
          discardReviewedState: true,
        })
      ).toThrow('already loaded');
    } finally {
      await session.close();
      await fixture.cleanup();
    }
  }
);

it.each(['database', 'both'] as const)(
  'uses the destination for legacy JSON to %s settings, visible identity and applied/draft tests',
  async (destination) => {
    const fixture = await makeCommandFixture(false);
    const session = new LicenseWorkbenchSession(fixture.options, false, fixture.dependencies);
    const test = vi.spyOn(database, 'testWorkbenchDatabase').mockResolvedValue();
    try {
      const target = {
        ...sessionConnection,
        database: 'destination-fixture',
        password: 'target-secret',
      };
      const options = {
        ...fixture.options,
        reportFormats: 'none' as const,
        cacheDir: session.visible.cacheDir,
        reportDir: session.visible.reportDir,
        discardReviewedState: false,
      };
      const changed = await session.configure({
        ...options,
        source: 'json',
        destination,
        configurationRevision: 1,
        sourceDatabaseConnection: sessionConnection,
        databaseConnection: target,
      });
      expect(changed.databaseConnection).toEqual(changed.destinationDatabaseConnection);
      expect(changed.databaseTarget).toContain(target.database);
      await session.testDatabase(changed.configurationRevision, { ...target, password: '' });
      expect(test).toHaveBeenLastCalledWith(
        expect.objectContaining({ database: target.database, password: target.password }),
        'draft-test'
      );
      await session.testDatabase(changed.configurationRevision);
      expect(test).toHaveBeenLastCalledWith(
        expect.objectContaining({ database: target.database, password: target.password }),
        'test'
      );
      expect(session.visible).toMatchObject({
        databaseTest: 'passed',
        destinationDatabaseTest: 'passed',
        sourceDatabaseTest: 'untested',
      });
      const switched = await session.configure({
        ...options,
        source: 'database',
        destination,
        configurationRevision: changed.configurationRevision,
        databaseConnection: { ...sessionConnection, password: '' },
      });
      expect(switched.databaseConnection).toEqual(switched.sourceDatabaseConnection);
      expect(switched.databaseTarget).toContain(sessionConnection.database);
      await session.testDatabase(switched.configurationRevision);
      expect(test).toHaveBeenLastCalledWith(
        expect.objectContaining({
          database: sessionConnection.database,
          password: sessionConnection.password,
        }),
        'test'
      );
    } finally {
      test.mockRestore();
      await session.close();
      await fixture.cleanup();
    }
  }
);

it.each([false, true])(
  'keeps reviewed practice A through failed B and only retires A after successful replacement (published %s)',
  async (published) => {
    const f = await makeCommandFixture(false);
    const session = new LicenseWorkbenchSession(f.options, true);
    const scratch = new Set<string>();
    async function operate(kind: 'inspect' | 'analysis') {
      const op = session.start(kind, {
        operationId: crypto.randomUUID(),
        configurationRevision: session.visible.configurationRevision,
        discardReviewedState: true,
        expectedContentRevision: session.visible.contentRevision,
      });
      await vi.waitFor(() => expect(session.operation(op.operationId)?.state).not.toBe('running'));
      if (session.visible.scratch) scratch.add(session.visible.scratch);
      return session.operation(op.operationId)?.state;
    }
    try {
      expect(await operate('inspect')).toBe('succeeded');
      expect(await operate('analysis')).toBe('succeeded');
      const row = session.listReview({ search: '', status: 'all', source: 'all', page: 1 }).rows[0];
      const { configurationRevision, contentRevision } = session.visible;
      session.editReview({
        configurationRevision,
        contentRevision,
        id: row.id,
        acknowledgeWarning: true,
        edit: {
          kind: 'disposition',
          normalizedText: row.normalizedText,
          status: 'allowed',
          reason: 'Kept practice edit.',
          reviewedBy: 'Fixture reviewer',
        },
      });
      const a = session.visible;
      await session.previewPractice(a.configurationRevision, a.contentRevision);
      if (published) {
        const op = await session.savePractice({
          configurationRevision: a.configurationRevision,
          contentRevision: a.contentRevision,
          operationId: crypto.randomUUID(),
        });
        await vi.waitFor(() => expect(session.operation(op.operationId)?.state).toBe('succeeded'));
      }
      const missing = join(f.dir, 'replacement.json');
      await session.configure({
        ...f.options,
        source: 'json',
        destination: 'json',
        input: missing,
        output: a.output,
        cacheDir: a.cacheDir,
        reportDir: a.reportDir,
        model: a.model,
        sampleCount: a.sampleCount,
        reportFormats: 'none',
        configurationRevision: a.configurationRevision,
        discardReviewedState: false,
      });
      expect(session.visible.sourceDraftPending).toBe(true);
      if (!published)
        expect(() =>
          session.start('inspect', {
            operationId: crypto.randomUUID(),
            configurationRevision: session.visible.configurationRevision,
          })
        ).toThrow('discard acknowledgement');
      expect(await operate('inspect')).toBe('failed');
      expect(session.visible).toMatchObject({
        scratch: a.scratch,
        loadRevision: a.loadRevision,
        loadedSource: { input: f.input },
        contentRevision: a.contentRevision,
      });
      expect(session.visible.preview).not.toBeNull();
      expect(session.reviewDetail(row.id).rationale).toBe('Kept practice edit.');
      await access(a.scratch!);
      await writeFile(missing, f.sourceBytes);
      expect(await operate('inspect')).toBe('succeeded');
      expect(session.visible).toMatchObject({
        sourceDraftPending: false,
        loadedSource: { input: missing },
        preview: null,
      });
      expect(session.visible.scratch).not.toBe(a.scratch);
      if (published) await access(a.output);
      else await expect(access(a.scratch!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await session.close();
      await Promise.all([...scratch].map((path) => rm(path, { recursive: true, force: true })));
      await f.cleanup();
    }
  }
);

it('blocks a fresh analysis operation with a pending replacement even when the loaded source has uncached model work', async () => {
  const f = await makeCommandFixture(false);
  const session = new LicenseWorkbenchSession(
    { ...f.options, source: 'database' },
    false,
    f.dependencies
  );
  try {
    const inspect = () =>
      session.start('inspect', {
        operationId: crypto.randomUUID(),
        configurationRevision: session.visible.configurationRevision,
      });
    const a = inspect();
    await vi.waitFor(() => expect(session.operation(a.operationId)?.state).toBe('succeeded'));
    const loaded = session.visible;
    expect(loaded.inspected?.preflight.expectedUncachedRequests).toBeGreaterThan(0);
    const b = await session.configure({
      ...f.options,
      source: 'json',
      destination: 'json',
      reportFormats: 'none',
      cacheDir: loaded.cacheDir,
      reportDir: loaded.reportDir,
      configurationRevision: loaded.configurationRevision,
      discardReviewedState: true,
      expectedContentRevision: loaded.contentRevision,
    });
    const blocked = {
      operationId: crypto.randomUUID(),
      configurationRevision: b.configurationRevision,
    };
    expect(() => session.start('analysis', blocked)).toThrow('Load the selected source');
    expect(session.operation(blocked.operationId)).toBeNull();
    expect(session.visible).toMatchObject({
      sourceDraftPending: true,
      loadedSource: loaded.loadedSource,
      analysis: loaded.analysis,
      inspected: loaded.inspected,
    });
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    const next = inspect();
    await vi.waitFor(() => expect(session.operation(next.operationId)?.state).toBe('succeeded'));
    expect(session.visible.sourceDraftPending).toBe(false);
    const analyze = session.start('analysis', {
      operationId: crypto.randomUUID(),
      configurationRevision: session.visible.configurationRevision,
    });
    await vi.waitFor(() => expect(session.operation(analyze.operationId)?.state).toBe('succeeded'));
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  } finally {
    await session.close();
    await f.cleanup();
  }
});

it('rejects stale direct and settings-based discard confirmations after another tab edits the loaded review', async () => {
  const f = await makeCommandFixture(false);
  const session = new LicenseWorkbenchSession(f.options, false, f.dependencies);
  const start = (kind: 'inspect' | 'analysis') =>
    session.start(kind, {
      operationId: crypto.randomUUID(),
      configurationRevision: session.visible.configurationRevision,
    });
  const done = async (op: { operationId: string }) =>
    vi.waitFor(() => expect(session.operation(op.operationId)?.state).toBe('succeeded'));
  try {
    await done(start('inspect'));
    await done(start('analysis'));
    const a = session.visible;
    const b = join(f.dir, 'source-b.json');
    await writeFile(b, f.sourceBytes);
    const confirmation = {
      ...f.options,
      source: 'json' as const,
      destination: 'json' as const,
      input: b,
      reportFormats: 'none' as const,
      cacheDir: a.cacheDir,
      reportDir: a.reportDir,
      configurationRevision: a.configurationRevision,
      discardReviewedState: true,
      expectedContentRevision: a.contentRevision,
    };
    await expect(
      session.configure({ ...confirmation, expectedContentRevision: a.contentRevision + 1 })
    ).rejects.toThrow('confirmation is stale');
    const draft = await session.configure(confirmation);
    const row = session.listReview({ search: '', status: 'all', source: 'all', page: 1 }).rows[0];
    session.editReview({
      id: row.id,
      configurationRevision: draft.configurationRevision,
      contentRevision: a.contentRevision,
      acknowledgeWarning: true,
      edit: {
        kind: 'disposition',
        normalizedText: row.normalizedText,
        status: 'allowed',
        reason: 'Newer edit from the other tab.',
        reviewedBy: 'Other tab',
      },
    });
    const request = {
      operationId: crypto.randomUUID(),
      configurationRevision: draft.configurationRevision,
      discardReviewedState: true,
      expectedContentRevision: a.contentRevision,
    };
    expect(() => session.start('inspect', request)).toThrow('confirmation is stale');
    expect(() => start('inspect')).toThrow('current content revision');
    expect(session.operation(request.operationId)).toBeNull();
    expect(session.reviewDetail(row.id).rationale).toBe('Newer edit from the other tab.');
    expect(session.visible.loadedSource?.input).toBe(f.input);
    const fresh = { ...request, expectedContentRevision: session.visible.contentRevision };
    await done(session.start('inspect', fresh));
    expect(session.start('inspect', fresh).state).toBe('succeeded');
    expect(() => session.start('inspect', request)).toThrow('reused');
    expect(session.visible.loadedSource?.input).toBe(b);
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  } finally {
    await session.close();
    await f.cleanup();
  }
});

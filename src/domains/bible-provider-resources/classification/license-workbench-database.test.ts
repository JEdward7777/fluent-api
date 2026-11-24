import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { parseLicenseCommandOptions } from './license-command-options';
import { makeCommandFixture } from './license-command.test-fixtures';
import {
  ownedWorkbenchDatabase,
  selectWorkbenchDatabase,
  visibleWorkbenchDatabase,
  workbenchDatabaseIdentity,
  workbenchDatabaseUrl,
} from './license-workbench-database';
import * as database from './license-workbench-database';
import { LicenseWorkbenchDatabaseError } from './license-workbench-database-error';
import { LicenseWorkbenchDatabaseTests } from './license-workbench-database-tests';
import { licenseWorkbenchBrowserError } from './license-workbench-error';
import { LicenseWorkbenchSession } from './license-workbench-session';

const parsed = parseLicenseCommandOptions(['--source=json', '--destination=json'], true);
if (parsed.help) throw new Error('Expected command options');
const secret = 'p@ss:/?# avoid-output';
const connection = {
  mode: 'session' as const,
  host: '127.0.0.1',
  port: 1,
  database: 'review_db',
  username: 'reader',
  password: secret,
  clearPassword: false,
  tls: 'verify-full' as const,
};

function settings(session: LicenseWorkbenchSession) {
  const view = session.visible;
  return {
    configurationRevision: view.configurationRevision,
    expectedContentRevision: view.contentRevision,
    discardReviewedState: false,
    source: view.source,
    destination: view.destination,
    input: view.input,
    output: view.output,
    model: view.model,
    sampleCount: view.sampleCount,
    force: view.force,
    noCache: view.noCache,
    cacheDir: view.cacheDir,
    reportFormats: view.reportFormats as 'none' | 'markdown' | 'html' | 'markdown,html',
    reportDir: view.reportDir,
    preserveExistingNonUnknowns: view.preserveExistingNonUnknowns,
  };
}

describe('session database connection', () => {
  it('redacts passwords and keeps two workbench sessions isolated', async () => {
    const first = new LicenseWorkbenchSession(parsed.options);
    const second = new LicenseWorkbenchSession(parsed.options);
    const environmentBefore = process.env.DATABASE_URL;
    try {
      const saved = await first.configure({
        ...settings(first),
        databaseConnection: connection,
      });
      expect(saved.databaseConnection).toEqual({
        mode: 'session',
        host: connection.host,
        port: connection.port,
        database: connection.database,
        username: connection.username,
        tls: connection.tls,
        passwordRetained: true,
      });
      expect(JSON.stringify(saved)).not.toContain(secret);
      expect(JSON.stringify(second.visible)).not.toContain(secret);
      expect(second.visible.databaseConnection).toEqual({ mode: 'environment' });
      expect(process.env.DATABASE_URL).toBe(environmentBefore);
      expect(
        await first.configure({
          ...settings(first),
          databaseConnection: { ...connection, password: '' },
        })
      ).toMatchObject({ databaseConnection: { passwordRetained: true } });
      expect(
        await first.configure({
          ...settings(first),
          databaseConnection: { ...connection, password: '', clearPassword: true },
        })
      ).toMatchObject({ databaseConnection: { passwordRetained: false } });
      await first.configure({ ...settings(first), databaseConnection: { mode: 'environment' } });
      expect(first.visible.databaseConnection).toEqual({ mode: 'environment' });
      expect(process.env.DATABASE_URL).toBe(environmentBefore);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('does not reuse a password for a changed identity and validates URL escaping', () => {
    const selected = selectWorkbenchDatabase({ mode: 'environment' }, connection);
    expect(selected.mode).toBe('session');
    for (const change of [
      { host: 'localhost' },
      { port: 5432 },
      { database: 'another-db' },
      { username: 'another-user' },
      { tls: 'disable' as const },
    ]) {
      expect(
        selectWorkbenchDatabase(selected, { ...connection, ...change, password: '' })
      ).toMatchObject({ password: '' });
    }
    expect(
      selectWorkbenchDatabase(selected, { ...connection, password: 'replacement' })
    ).toMatchObject({ password: 'replacement' });
    expect(
      selectWorkbenchDatabase(selected, { ...connection, password: 'filled', clearPassword: true })
    ).toMatchObject({ password: '' });
    const url = new URL(workbenchDatabaseUrl(selected));
    expect(decodeURIComponent(url.password)).toBe(secret);
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    expect(workbenchDatabaseIdentity(selected)).not.toContain(secret);
    expect(JSON.stringify(visibleWorkbenchDatabase(selected))).not.toContain(secret);
  });

  it('reports an unreachable inspection without exposing database credentials or SQL', async () => {
    const adapter = await ownedWorkbenchDatabase(connection);
    try {
      await expect(adapter.load()).rejects.toThrow(/^Database inspection failed/);
      const message = await adapter.load().catch(licenseWorkbenchBrowserError);
      expect(message).toBe(
        'Database inspection failed. The database refused the connection. Check the host, port and whether PostgreSQL is listening.'
      );
    } finally {
      await adapter.close?.();
    }
  });

  it('tests applied settings only, reports a refusal and rejects stale revisions', async () => {
    const session = new LicenseWorkbenchSession(parsed.options);
    try {
      await session.configure({ ...settings(session), databaseConnection: connection });
      await expect(session.testDatabase(1)).rejects.toThrow('Configuration changed');
      await expect(session.testDatabase(2)).rejects.toThrow('The database refused the connection.');
      expect(session.visible.databaseTest).toBe('failed');
      expect(JSON.stringify(session.visible)).not.toContain(secret);
      expect(JSON.stringify(session.visible)).not.toContain('ECONNREFUSED');
    } finally {
      await session.close();
    }
  });
});

describe('sanitized database failure guidance', () => {
  const error = (code: string) =>
    Object.assign(new Error(`postgres://reader:${secret}@host`), { code });

  it.each([
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS certificate verification failed'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'trusted certificate chain'],
    ['28P01', 'rejected authentication'],
    ['28000', 'access settings'],
    ['3D000', 'could not find the selected database'],
    ['42P01', 'required database schema is missing'],
    ['ENOTFOUND', 'hostname could not be resolved'],
    ['ECONNREFUSED', 'database refused the connection'],
    ['ETIMEDOUT', 'connection timed out'],
    ['CONNECT_TIMEOUT', 'connection timed out'],
    ['DATABASE_URL_MISSING', 'Set DATABASE_URL'],
    ['ERR_UNKNOWN', 'Check the selected host, port, credentials'],
  ])('gives fixed guidance for %s without disclosing the driver error', (code, expected) => {
    const cause = new Error('wrapped SQL', {
      cause: new AggregateError([error(code)], 'connection attempts failed'),
    });
    const failure = new LicenseWorkbenchDatabaseError('test', cause);
    expect(failure.message).toContain(expected);
    expect(failure.message).not.toContain(secret);
    expect(failure.message).not.toContain('wrapped SQL');
  });

  it('suggests disabling TLS only conditionally for a trusted local server after a reset', () => {
    expect(
      new LicenseWorkbenchDatabaseError('test', error('ECONNRESET'), 'session').message
    ).toContain('If this trusted local PostgreSQL server has TLS disabled');
    expect(
      new LicenseWorkbenchDatabaseError('inspect', error('ECONNRESET'), 'environment').message
    ).toContain('set sslmode=disable and remove sslrootcert=system if present');
    expect(new LicenseWorkbenchDatabaseError('test', error('ECONNRESET')).message).not.toContain(
      'Disable TLS'
    );
  });
});

describe('draft database tests', () => {
  it('tests entered credentials without applying them and blocks concurrent Apply and Test', async () => {
    const pending = Promise.withResolvers<void>();
    const test = vi.spyOn(database, 'testWorkbenchDatabase').mockReturnValue(pending.promise);
    const session = new LicenseWorkbenchSession(parsed.options);
    try {
      await session.configure({ ...settings(session), databaseConnection: connection });
      const snapshot = session.visible;
      const draft = { ...connection, host: 'new-host', password: '' };
      const request = session.testDatabase(snapshot.configurationRevision, draft);
      expect(test).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'new-host', password: '' }),
        'draft-test'
      );
      expect(session.visible.testingDatabase).toBe(true);
      await expect(session.testDatabase(snapshot.configurationRevision, draft)).rejects.toThrow(
        'Cannot test'
      );
      await expect(
        session.configure({ ...settings(session), databaseConnection: draft })
      ).rejects.toThrow('database test');
      pending.resolve();
      await expect(request).resolves.toEqual({ tested: true });
      expect(session.visible).toEqual(snapshot);

      await expect(session.testDatabase(1, draft)).rejects.toThrow('Configuration changed');
      expect(test).toHaveBeenCalledTimes(1);
      await session.testDatabase(snapshot.configurationRevision, { ...connection, password: '' });
      expect(test).toHaveBeenLastCalledWith(
        expect.objectContaining({ password: secret }),
        'draft-test'
      );
      await session.testDatabase(snapshot.configurationRevision, {
        ...connection,
        password: 'new',
        clearPassword: true,
      });
      expect(test).toHaveBeenLastCalledWith(
        expect.objectContaining({ password: '' }),
        'draft-test'
      );
      await session.testDatabase(snapshot.configurationRevision);
      expect(session.visible.databaseTest).toBe('passed');
      test.mockRejectedValueOnce(new Error('fixture rejection'));
      await expect(
        session.testDatabase(snapshot.configurationRevision, { mode: 'environment' })
      ).rejects.toThrow();
      expect(session.visible.databaseTest).toBe('passed');
    } finally {
      pending.resolve();
      await session.close();
      test.mockRestore();
    }
  });

  it('rejects Test until an async review preparation completes and waits for a live Test on close', async () => {
    const reservation = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    const test = vi.spyOn(database, 'testWorkbenchDatabase').mockReturnValue(pending.promise);
    const checks = new LicenseWorkbenchDatabaseTests();
    try {
      const review = checks.reserve(() => reservation.promise);
      await expect(checks.run({ mode: 'environment' }, true)).rejects.toThrow('Cannot test');
      expect(test).not.toHaveBeenCalled();
      reservation.resolve();
      await review;
      const active = checks.run({ mode: 'environment' }, true);
      let closed = false;
      const closing = checks.settle().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      pending.resolve();
      await Promise.all([active, closing]);
      expect(closed).toBe(true);
    } finally {
      reservation.resolve();
      pending.resolve();
      test.mockRestore();
    }
  });
});

describe('source and destination connection ownership', () => {
  async function operate(session: LicenseWorkbenchSession, kind: 'inspect' | 'analysis') {
    const request = {
      operationId: crypto.randomUUID(),
      configurationRevision: session.visible.configurationRevision,
    };
    session.start(kind, request);
    await vi.waitFor(() =>
      expect(session.operation(request.operationId)?.state).not.toBe('running')
    );
    return session.operation(request.operationId);
  }

  it('loads source policy without any destination and copies the connection once after success', async () => {
    const fixture = await makeCommandFixture(false);
    const other = await makeCommandFixture(false);
    const session = new LicenseWorkbenchSession(
      { ...fixture.options, source: 'database', destination: undefined },
      false,
      {
        ...fixture.dependencies,
        destinationDatabase: other.dependencies.database,
      }
    );
    const test = vi.spyOn(database, 'testWorkbenchDatabase').mockResolvedValue();
    try {
      await session.configure({ ...settings(session), sourceDatabaseConnection: connection });
      expect((await operate(session, 'inspect'))?.state).toBe('succeeded');
      const loaded = session.visible;
      expect(loaded.analysis?.rows).toBeGreaterThan(0);
      expect(loaded.destinationDatabaseConnection).toEqual(loaded.sourceDatabaseConnection);
      expect(other.dependencies.database).not.toHaveBeenCalled();
      expect(fixture.dependencies.transport).not.toHaveBeenCalled();
      await session.testDatabase(
        loaded.destinationRevision,
        { ...connection, password: '' },
        'destination'
      );
      expect(test).toHaveBeenLastCalledWith(
        expect.objectContaining({ password: secret }),
        'draft-test'
      );
      const destination = {
        ...connection,
        database: 'other',
        tls: 'disable' as const,
        password: 'destination-only-password',
      };
      await session.configure({
        ...settings(session),
        destination: 'database',
        destinationDatabaseConnection: destination,
      });
      const changed = session.visible;
      expect(changed).toMatchObject({
        sourceRevision: loaded.sourceRevision,
        loadRevision: loaded.loadRevision,
        contentRevision: loaded.contentRevision,
        inspected: loaded.inspected,
      });
      expect(fixture.adapter.load).toHaveBeenCalledTimes(1);
      await session.testDatabase(changed.sourceRevision, { ...connection, password: '' }, 'source');
      expect(test).toHaveBeenLastCalledWith(
        expect.objectContaining({ password: secret }),
        'draft-test'
      );
      await session.testDatabase(
        changed.destinationRevision,
        { ...destination, password: '' },
        'destination'
      );
      expect(test).toHaveBeenLastCalledWith(
        expect.objectContaining({ password: destination.password }),
        'draft-test'
      );
      await expect(
        session.testDatabase(loaded.destinationRevision, destination, 'destination')
      ).rejects.toThrow('Configuration changed');
      expect(JSON.stringify(changed)).not.toContain(secret);
      expect(JSON.stringify(changed)).not.toContain(destination.password);
      expect(JSON.stringify(changed)).not.toContain('postgres://');
      await session.preview(changed.configurationRevision, changed.contentRevision);
      expect(other.dependencies.database).toHaveBeenCalledOnce();
      expect(other.adapter.load).toHaveBeenCalledOnce();
      expect(session.visible.preview).toMatchObject({
        sourceLabel: expect.stringContaining(connection.database),
        destinationDatabaseLabel: expect.stringContaining('other'),
      });
      await session.configure({ ...settings(session), source: 'json', input: fixture.input });
      expect(session.visible.preview).toMatchObject({
        sourceLabel: expect.stringContaining(connection.database),
        destinationDatabaseLabel: expect.stringContaining('other'),
      });
      other.adapter.load.mockRejectedValueOnce(new Error(secret));
      const saveDestination = () =>
        session.save({
          operationId: crypto.randomUUID(),
          configurationRevision: session.visible.configurationRevision,
          contentRevision: changed.contentRevision,
          agreeToReplace: false,
        });
      const unavailable = saveDestination();
      await vi.waitFor(() =>
        expect(session.operation(unavailable.operationId)).toMatchObject({
          state: 'failed',
          error: expect.stringContaining('save destination'),
        })
      );
      expect(session.visible).toMatchObject({
        state: 'reviewing',
        analysis: loaded.analysis,
        preview: null,
      });
      expect(other.adapter.apply).not.toHaveBeenCalled();
      expect(JSON.stringify(session.visible)).not.toContain(secret);
      await session.preview(session.visible.configurationRevision, changed.contentRevision);
      const save = saveDestination();
      await vi.waitFor(() => expect(session.operation(save.operationId)?.state).toBe('succeeded'));
      expect(other.adapter.apply).toHaveBeenCalledOnce();
      expect(fixture.adapter.apply).not.toHaveBeenCalled();
      await session.configure({ ...settings(session), destination: 'json' });
      expect(other.adapter.close).toHaveBeenCalledOnce();
      expect(fixture.adapter.close).not.toHaveBeenCalled();
      await session.configure({
        ...settings(session),
        source: 'database',
        sourceDatabaseConnection: { ...connection, database: 'source2', password: '' },
        discardReviewedState: true,
      });
      expect((await operate(session, 'inspect'))?.state).toBe('succeeded');
      expect(session.visible.destinationDatabaseConnection).toMatchObject({
        database: 'other',
        passwordRetained: true,
      });
      expect(session.visible.sourceDatabaseConnection).toMatchObject({
        database: 'source2',
        passwordRetained: false,
      });
    } finally {
      test.mockRestore();
      await session.close();
      await Promise.all([fixture.cleanup(), other.cleanup()]);
    }
  });

  it('recovers from an analysis failure on the same source and settles failed pool cleanup on both replacement paths', async () => {
    const fixture = await makeCommandFixture(false);
    const session = new LicenseWorkbenchSession(
      { ...fixture.options, source: 'database' },
      false,
      fixture.dependencies
    );
    try {
      expect((await operate(session, 'inspect'))?.state).toBe('succeeded');
      fixture.adapter.load.mockRejectedValueOnce(new Error('source unavailable'));
      expect((await operate(session, 'analysis'))?.state).toBe('failed');
      expect(session.visible.state).toBe('error');
      fixture.adapter.close.mockRejectedValueOnce(new Error(secret));
      expect(await operate(session, 'inspect')).toMatchObject({
        state: 'succeeded',
        cleanupWarning: expect.stringContaining('cleanup'),
      });
      expect(session.visible.activeOperationId).toBeNull();
      const prior = session.visible;
      await session.configure({ ...settings(session), sourceDatabaseConnection: connection });
      fixture.adapter.load.mockRejectedValueOnce(new Error('could not load'));
      fixture.adapter.close.mockRejectedValueOnce(new Error(secret));
      expect(await operate(session, 'inspect')).toMatchObject({
        state: 'failed',
        cleanupWarning: expect.stringContaining('cleanup'),
      });
      expect(session.visible).toMatchObject({
        activeOperationId: null,
        loadRevision: prior.loadRevision,
        analysis: prior.analysis,
        inspected: prior.inspected,
      });
      expect(JSON.stringify(session.visible)).not.toContain(secret);
      expect((await operate(session, 'inspect'))?.state).toBe('succeeded');
    } finally {
      await session.close();
      await fixture.cleanup();
    }
  });

  it('keeps malformed JSON and database TLS failures distinct and leaves the loaded review intact', async () => {
    const fixture = await makeCommandFixture(false);
    const destinationDatabase = vi.fn(async () => {
      throw new Error('Unexpected destination access');
    });
    const session = new LicenseWorkbenchSession(
      { ...fixture.options, destination: 'database' },
      false,
      {
        ...fixture.dependencies,
        destinationDatabase,
        database: async () => {
          throw new LicenseWorkbenchDatabaseError(
            'inspect',
            Object.assign(new Error(secret), { code: 'CERT_HAS_EXPIRED' })
          );
        },
      }
    );
    try {
      expect((await operate(session, 'inspect'))?.state).toBe('succeeded');
      const loaded = session.visible;
      await writeFile(fixture.output, '{"bad":');
      await session.configure({
        ...settings(session),
        input: fixture.output,
        discardReviewedState: true,
      });
      expect(await operate(session, 'inspect')).toMatchObject({
        state: 'failed',
        error: expect.stringContaining('Invalid JSON source'),
      });
      await session.configure({
        ...settings(session),
        source: 'database',
        discardReviewedState: true,
      });
      expect(await operate(session, 'inspect')).toMatchObject({
        state: 'failed',
        error: expect.stringContaining('certificate verification failed'),
      });
      expect(session.visible).toMatchObject({
        loadRevision: loaded.loadRevision,
        loadedSource: loaded.loadedSource,
        analysis: loaded.analysis,
        inspected: loaded.inspected,
      });
      expect(JSON.stringify(session.visible)).not.toContain(secret);
      expect(destinationDatabase).not.toHaveBeenCalled();
      expect(fixture.dependencies.transport).not.toHaveBeenCalled();
    } finally {
      await session.close();
      await fixture.cleanup();
    }
  });
});

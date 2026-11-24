import { describe, expect, it } from 'vitest';

import { parseLicenseCommandOptions } from './license-command-options';
import {
  ownedWorkbenchDatabase,
  selectWorkbenchDatabase,
  visibleWorkbenchDatabase,
  workbenchDatabaseIdentity,
  workbenchDatabaseUrl,
} from './license-workbench-database';
import { LicenseWorkbenchDatabaseError } from './license-workbench-database-error';
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
    ).toContain('a trusted local server without TLS');
    expect(new LicenseWorkbenchDatabaseError('test', error('ECONNRESET')).message).not.toContain(
      'Disable TLS'
    );
  });
});

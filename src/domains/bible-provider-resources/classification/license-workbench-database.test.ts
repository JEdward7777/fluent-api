import { describe, expect, it } from 'vitest';

import { parseLicenseCommandOptions } from './license-command-options';
import {
  selectWorkbenchDatabase,
  visibleWorkbenchDatabase,
  workbenchDatabaseIdentity,
  workbenchDatabaseUrl,
} from './license-workbench-database';
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
    expect(
      selectWorkbenchDatabase(selected, { ...connection, host: 'localhost', password: '' })
    ).toMatchObject({ password: '' });
    const url = new URL(workbenchDatabaseUrl(selected));
    expect(decodeURIComponent(url.password)).toBe(secret);
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    expect(workbenchDatabaseIdentity(selected)).not.toContain(secret);
    expect(JSON.stringify(visibleWorkbenchDatabase(selected))).not.toContain(secret);
  });

  it('tests applied settings only, gives generic failures and rejects stale revisions', async () => {
    const session = new LicenseWorkbenchSession(parsed.options);
    try {
      await session.configure({ ...settings(session), databaseConnection: connection });
      await expect(session.testDatabase(1)).rejects.toThrow('Configuration changed');
      await expect(session.testDatabase(2)).rejects.toThrow('Connection failed');
      expect(session.visible.databaseTest).toBe('failed');
      expect(JSON.stringify(session.visible)).not.toContain(secret);
      expect(JSON.stringify(session.visible)).not.toContain('ECONNREFUSED');
    } finally {
      await session.close();
    }
  });
});

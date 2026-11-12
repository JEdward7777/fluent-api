import type { z } from 'zod';

import postgres from 'postgres';

import type { setupSchema } from './license-workbench-schema';

export type WorkbenchDatabase =
  | { mode: 'environment' }
  | {
      mode: 'session';
      host: string;
      port: number;
      database: string;
      username: string;
      password: string;
      tls: 'verify-full' | 'disable';
    };

export function selectWorkbenchDatabase(
  current: WorkbenchDatabase,
  selected: z.infer<typeof setupSchema>['databaseConnection']
): WorkbenchDatabase {
  if (!selected || selected.mode === 'environment') return { mode: 'environment' };
  const sameIdentity =
    current.mode === 'session' &&
    current.host === selected.host &&
    current.port === selected.port &&
    current.database === selected.database &&
    current.username === selected.username &&
    current.tls === selected.tls;
  return {
    mode: 'session',
    host: selected.host,
    port: selected.port,
    database: selected.database,
    username: selected.username,
    tls: selected.tls,
    password: selected.clearPassword
      ? ''
      : selected.password || (sameIdentity ? current.password : ''),
  };
}

export function visibleWorkbenchDatabase(connection: WorkbenchDatabase) {
  if (connection.mode === 'environment') return { mode: 'environment' as const };
  return {
    mode: 'session' as const,
    host: connection.host,
    port: connection.port,
    database: connection.database,
    username: connection.username,
    tls: connection.tls,
    passwordRetained: Boolean(connection.password),
  };
}

export function workbenchDatabaseUrl(connection: WorkbenchDatabase): string {
  if (connection.mode === 'environment') {
    const value = process.env.DATABASE_URL;
    if (!value) throw new Error('No environment database connection is configured');
    return value;
  }
  const url = new URL('postgres://localhost');
  url.hostname = connection.host;
  url.port = String(connection.port);
  url.pathname = `/${encodeURIComponent(connection.database)}`;
  url.username = encodeURIComponent(connection.username);
  url.password = encodeURIComponent(connection.password);
  url.searchParams.set('sslmode', connection.tls);
  return url.toString();
}

export function workbenchDatabaseIdentity(connection: WorkbenchDatabase): string {
  if (connection.mode === 'session')
    return `Session database: ${connection.host}:${connection.port}/${connection.database} · TLS ${connection.tls === 'verify-full' ? 'verification required' : 'disabled'}`;
  try {
    const url = new URL(workbenchDatabaseUrl(connection));
    return `Environment database: ${url.hostname}:${url.port || 'default'}/${decodeURIComponent(url.pathname.slice(1))}`;
  } catch {
    return 'Environment database: identity unavailable; check server configuration';
  }
}

export async function testWorkbenchDatabase(connection: WorkbenchDatabase): Promise<void> {
  const client = postgres(workbenchDatabaseUrl(connection), {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 5,
    ...(connection.mode === 'session' ? { password: () => connection.password } : {}),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client`select 1`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Database test timed out')), 8000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await client.end({ timeout: 1 });
  }
}

export async function ownedWorkbenchDatabase(connection: WorkbenchDatabase) {
  const { createOwnedLicenseDatabaseAdapter } = await import('./license-classifications.service');
  return createOwnedLicenseDatabaseAdapter(
    workbenchDatabaseUrl(connection),
    connection.mode === 'session' ? () => connection.password : undefined
  );
}

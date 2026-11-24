type DatabaseFailureOperation = 'test' | 'draft-test' | 'inspect';

function databaseErrorCodes(cause: unknown) {
  const pending = [cause];
  const seen = new Set<Error>();
  const codes = new Set<string>();
  while (pending.length) {
    const error = pending.pop();
    if (!(error instanceof Error) || seen.has(error)) continue;
    seen.add(error);
    if ('code' in error && typeof error.code === 'string') codes.add(error.code);
    pending.push(error.cause);
    if (error instanceof AggregateError) pending.push(...error.errors);
  }
  return codes;
}

function guidance(
  operation: DatabaseFailureOperation,
  cause: unknown,
  tls?: 'session' | 'environment'
) {
  const codes = databaseErrorCodes(cause);
  const has = (...values: string[]) => values.some((value) => codes.has(value));
  if (has('DATABASE_URL_MISSING')) return 'Set DATABASE_URL or select a session connection.';
  if (has('ERR_INVALID_URL')) return 'Check that the selected database URL is valid.';
  if (
    has(
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
    )
  )
    return 'PostgreSQL TLS certificate verification failed. Check the database hostname, certificate validity and trusted certificate chain.';
  if (has('28P01', '28000'))
    return 'PostgreSQL rejected authentication. Check the username, password and the database server’s access settings.';
  if (has('3D000')) return 'PostgreSQL could not find the selected database. Check its name.';
  if (has('42P01'))
    return 'The required database schema is missing. Apply its migrations before Inspect.';
  if (has('ENOTFOUND', 'EAI_AGAIN'))
    return 'The database hostname could not be resolved. Check the host and network.';
  if (has('ECONNREFUSED'))
    return 'The database refused the connection. Check the host, port and whether PostgreSQL is listening.';
  if (has('CONNECT_TIMEOUT', 'ETIMEDOUT'))
    return 'The database connection timed out. Check the host, port, network and firewall.';
  if (has('ECONNRESET', 'CONNECTION_CLOSED', 'ERR_SSL_WRONG_VERSION_NUMBER')) {
    const disconnected =
      'The server closed the connection. Check the host, port and PostgreSQL TLS configuration.';
    if (tls === 'session') {
      const next =
        operation === 'draft-test'
          ? 're-enter the password and retest'
          : 're-enter the password, apply settings and retest';
      return `${disconnected} If this trusted local PostgreSQL server has TLS disabled, select “Disable TLS (local/trusted connections only)”, ${next}.`;
    }
    if (tls === 'environment')
      return `${disconnected} For a trusted local server without TLS, set sslmode=disable and remove sslrootcert=system if present in DATABASE_URL.`;
    return disconnected;
  }
  if (operation === 'inspect' && !codes.size)
    return 'Could not read the database inventory or stored classification evidence. Check the selected database and stored data.';
  return 'Check the selected host, port, credentials, TLS setting and database schema.';
}

export class LicenseWorkbenchDatabaseError extends Error {
  constructor(
    operation: DatabaseFailureOperation,
    cause: unknown,
    tls?: 'session' | 'environment'
  ) {
    const prefix = operation === 'inspect' ? 'Database inspection failed.' : 'Connection failed.';
    super(`${prefix} ${guidance(operation, cause, tls)}`, { cause });
    this.name = 'LicenseWorkbenchDatabaseError';
  }
}

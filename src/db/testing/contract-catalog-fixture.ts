import { migrationStatements } from './create-catalogue-schema';

interface MigrationExecutor {
  exec: (query: string) => Promise<unknown>;
}

/** PGlite owns its transaction; PostgreSQL callers supply a sql.begin executor. */
export async function contractCatalogFixture(
  client: MigrationExecutor & {
    transaction?: (work: (tx: MigrationExecutor) => Promise<unknown>) => Promise<unknown>;
  }
) {
  const sql = migrationStatements('0049_license_identity_contract.sql').join('\n');
  if (client.transaction) await client.transaction((tx) => tx.exec(sql));
  else await client.exec(sql);
}

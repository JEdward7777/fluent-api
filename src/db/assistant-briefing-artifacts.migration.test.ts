import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('creates the standalone completed-artifact table on a fresh database', async () => {
  const database = new PGlite();
  try {
    const migration = await readFile(
      new URL('./migrations/0041_assistant_artifacts.sql', import.meta.url),
      'utf8'
    );
    await database.exec(migration);
    const key = 'a'.repeat(64);
    await database.query(
      `INSERT INTO assistant_briefing_artifacts (
        cache_key, markdown, operation_version, profile_version, resource_policy_version,
        cache_epoch, output_contract_version, response_language_hint, resource_language,
        source_language_code, expires_at
      ) VALUES ($1, $2, 'briefing-v1', 'profile-v1', 'resources-v1', '1', 'widgets-v1',
        'en', 'en', 'eng', CURRENT_TIMESTAMP + INTERVAL '1 day')`,
      [key, 'completed markdown']
    );
    const { rows } = await database.query(
      `SELECT cache_key, markdown, created_at IS NOT NULL AS has_created,
        completed_at IS NOT NULL AS has_completed, expires_at > CURRENT_TIMESTAMP AS unexpired
       FROM assistant_briefing_artifacts`
    );
    expect(rows).toEqual([
      {
        cache_key: key,
        markdown: 'completed markdown',
        has_created: true,
        has_completed: true,
        unexpired: true,
      },
    ]);
  } finally {
    await database.close();
  }
}, 30000);

it('applies the complete migration journal to a fresh PostgreSQL-compatible database', async () => {
  const database = new PGlite();
  try {
    await migrate(drizzle(database), {
      migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)),
    });
    const { rows } = await database.query(
      `SELECT cache_key FROM assistant_briefing_artifacts WHERE expires_at > CURRENT_TIMESTAMP`
    );
    expect(rows).toEqual([]);
    expect((await database.query('SELECT cache_key FROM assistant_turn_artifacts')).rows).toEqual(
      []
    );
  } finally {
    await database.close();
  }
}, 60000);

it('upgrades an existing Assistant database without losing its artifact', async () => {
  const database = new PGlite();
  const temporaryMigrations = await mkdtemp(join(tmpdir(), 'fluent-license-migrations-'));
  const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));
  try {
    const journal = JSON.parse(
      await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')
    ) as { entries: { tag: string }[] };
    const mainJournal = { ...journal, entries: journal.entries.slice(0, 42) };
    await mkdir(join(temporaryMigrations, 'meta'));
    await writeFile(
      join(temporaryMigrations, 'meta', '_journal.json'),
      JSON.stringify(mainJournal)
    );
    await Promise.all(
      mainJournal.entries.map(({ tag }) =>
        cp(join(migrationsFolder, `${tag}.sql`), join(temporaryMigrations, `${tag}.sql`))
      )
    );

    await migrate(drizzle(database), { migrationsFolder: temporaryMigrations });
    const key = 'b'.repeat(64);
    await database.query(
      `INSERT INTO assistant_briefing_artifacts (
        cache_key, markdown, operation_version, profile_version, resource_policy_version,
        cache_epoch, output_contract_version, response_language_hint, resource_language,
        source_language_code, expires_at
      ) VALUES ($1, $2, 'briefing-v1', 'profile-v1', 'resources-v1', '1', 'widgets-v1',
        'en', 'en', 'eng', CURRENT_TIMESTAMP + INTERVAL '1 day')`,
      [key, 'retained artifact']
    );

    await migrate(drizzle(database), { migrationsFolder });
    expect(
      (await database.query('SELECT cache_key, markdown FROM assistant_briefing_artifacts')).rows
    ).toEqual([{ cache_key: key, markdown: 'retained artifact' }]);
    expect((await database.query('SELECT * FROM license_classifications')).rows).toEqual([]);
  } finally {
    await database.close();
    await rm(temporaryMigrations, { recursive: true, force: true });
  }
}, 60000);

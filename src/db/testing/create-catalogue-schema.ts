import type { PGlite } from '@electric-sql/pglite';

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { catalogue_watermark } from '../schema';

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Split a Drizzle SQL migration file on statement breakpoints. */
export function migrationStatements(fileName: string): string[] {
  return readFileSync(join(migrationDir, fileName), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** Install next_catalogue_watermark() before CREATE TABLE … DEFAULT that references it. */
async function installNextCatalogueWatermarkFunction(client: Pick<PGlite, 'exec'>): Promise<void> {
  const allocator = migrationStatements('0038_catalogue_watermark_allocator.sql').find(
    (statement) => statement.includes('CREATE FUNCTION next_catalogue_watermark()')
  );
  if (!allocator) throw new Error('Catalogue allocator migration is missing');
  await client.exec(allocator);
}

/** Seed the singleton after catalogue_watermark exists (schema gen or migration). */
async function seedCatalogueWatermarkSingleton(client: Pick<PGlite, 'exec'>): Promise<void> {
  await client.exec(`INSERT INTO catalogue_watermark (id, updated_at)
    VALUES (true, clock_timestamp() AT TIME ZONE 'UTC')
    ON CONFLICT (id) DO NOTHING`);
}

/** bump_linked_bibles function + trigger; fires on bible_provider_resources, updates bibles. */
async function installProviderResourceLicenseTrigger(client: Pick<PGlite, 'exec'>): Promise<void> {
  await client.exec(
    'DROP TRIGGER IF EXISTS trg_bump_bibles_on_provider_resource_license ON bible_provider_resources'
  );
  for (const statement of migrationStatements('0047_provider_resource_link_bridge.sql')) {
    if (/CREATE (?:OR REPLACE )?(?:FUNCTION|TRIGGER) /.test(statement)) {
      await client.exec(statement);
    }
  }
  for (const statement of migrationStatements('0048_canonical_resource_watermarks.sql'))
    await client.exec(statement);
}

/**
 * Generate and execute schema DDL for a PGlite fixture through one path so
 * tests cannot drift from the catalogue watermark contract:
 * next_catalogue_watermark() exists before the CREATE TABLE … DEFAULT
 * expressions referencing it, catalogue_watermark is always generated, and its
 * singleton is seeded before inserts. The provider-resource license trigger is
 * installed when both tables it spans are present.
 */
export async function createTestSchema(
  client: PGlite,
  tables: Parameters<typeof generateDrizzleJson>[0]
): Promise<void> {
  await installNextCatalogueWatermarkFunction(client);
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ ...tables, catalogue_watermark })
  );
  await client.exec(statements.join('\n'));
  await seedCatalogueWatermarkSingleton(client);

  if ('bible_provider_resources' in tables) {
    const bridge = migrationStatements('0045_license_notice_bridge_and_watermarks.sql').filter(
      (statement) =>
        statement.includes('CREATE OR REPLACE FUNCTION bridge_recording_license_notice()') ||
        statement.includes('CREATE TRIGGER trg_bridge_recording_license_notice')
    );
    for (const statement of bridge) await client.exec(statement);
  }
  if ('bibles' in tables && 'bible_provider_resources' in tables) {
    await installProviderResourceLicenseTrigger(client);
  }
}

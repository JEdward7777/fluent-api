import type { PGlite } from '@electric-sql/pglite';

import { migrationStatements } from './create-catalogue-schema';

/** Release-1 physical model, including an unowned column to prove backfill preserves metadata. */
export async function createResourceLinkLegacyFixture(client: PGlite) {
  await client.exec(`
    CREATE TYPE bible_provider AS ENUM ('dbl','aquifer','youversion');
    CREATE TYPE resource_provider AS ENUM ('dbl','aquifer','youversion');
    CREATE TYPE tts_license_status AS ENUM ('allowed','forbidden','unknown');
    CREATE TABLE catalogue_watermark (id boolean PRIMARY KEY, updated_at timestamp NOT NULL);
    INSERT INTO catalogue_watermark VALUES (true,'2090-01-01');
    CREATE TABLE bible_provider_resources (
      id serial PRIMARY KEY, provider resource_provider NOT NULL, external_id varchar(255) NOT NULL,
      tts_license_status tts_license_status NOT NULL DEFAULT 'unknown',
      license_notice text, recording_license_notice text, text_license_notice text,
      display_name text, extension jsonb, UNIQUE(provider,external_id)
    );
    CREATE TABLE bibles (
      id serial PRIMARY KEY, language_id integer NOT NULL DEFAULT 1,
      name varchar(255) NOT NULL UNIQUE, abbreviation varchar(50) NOT NULL UNIQUE,
      provider bible_provider NOT NULL DEFAULT 'dbl', external_id varchar(255),
      has_audio boolean NOT NULL DEFAULT false,
      audio_resource_id integer REFERENCES bible_provider_resources(id) ON DELETE RESTRICT,
      created_at timestamp DEFAULT now(), updated_at timestamp
    );
    CREATE UNIQUE INDEX idx_bibles_provider_external_id ON bibles(provider,external_id) WHERE external_id IS NOT NULL;
    CREATE TABLE license_classifications (normalized_text text PRIMARY KEY, status tts_license_status, rationale jsonb);
    INSERT INTO license_classifications VALUES ('retained','unknown','{"humanNote":"Retained review"}');
  `);
  const allocator = migrationStatements('0038_catalogue_watermark_allocator.sql').find(
    (statement) => statement.includes('CREATE FUNCTION next_catalogue_watermark()')
  );
  if (!allocator) throw new Error('Missing catalog allocator');
  await client.exec(allocator);
  await client.exec(
    'ALTER TABLE bibles ALTER COLUMN updated_at SET DEFAULT next_catalogue_watermark()'
  );
  for (const statement of migrationStatements('0044_license_notice_bridge_and_watermarks.sql'))
    await client.exec(statement);
}

export async function expandResourceLinks(client: PGlite) {
  await client.transaction(async (tx) => {
    for (const name of [
      '0045_provider_resource_link_expand.sql',
      '0046_provider_resource_link_bridge.sql',
    ]) {
      for (const statement of migrationStatements(name)) await tx.exec(statement);
    }
  });
}

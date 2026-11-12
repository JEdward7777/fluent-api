import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { contractCatalogFixture } from '@/db/testing/contract-catalog-fixture';

import { integrityDigest } from './assistant.receipts';

import { resolveCanonicalPassage } from './assistant.repository';

const databaseState = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@/db', () => ({
  get db() {
    return databaseState.db;
  },
}));

let client: PGlite;
const input = { projectId: 7, bookCode: 'mat', chapter: 4, activeVerse: 25 };

beforeAll(async () => {
  client = new PGlite();
  databaseState.db = drizzle(client, { schema });
  await migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
  });
}, 60000);

async function seedPassage(database: PGlite) {
  await database.exec(`
    TRUNCATE projects, bibles, languages, organizations, books, pericope_sets,
      pericope_verses, bible_texts CASCADE;
    INSERT INTO languages (id, lang_name, lang_code_iso_639_3)
      VALUES (1, 'English', 'eng'), (2, 'Target', 'hin');
    INSERT INTO organizations (id, name) VALUES (1, 'Test Organization');
    INSERT INTO pericope_sets (id, name) VALUES (3, 'Test Set');
    INSERT INTO bibles (id, language_id, name, abbreviation)
      VALUES (9, 1, 'Canonical Source', 'SRC');
    INSERT INTO books (id, code, eng_display_name) VALUES (40, 'MAT', 'Matthew');
    INSERT INTO projects (
      id, name, source_language, target_language, organization, source_bible_id, pericope_set_id
    ) VALUES (7, 'Project', 1, 2, 1, 9, 3);
    INSERT INTO pericope_verses (
      pericope_set_id, book_id, chapter_number, verse_number, pericope_number
    ) VALUES (3, 40, 4, 25, '12'), (3, 40, 5, 1, '12'), (3, 40, 5, 2, '12');
    INSERT INTO bible_texts (bible_id, book_id, chapter_number, verse_number, text)
    VALUES (9, 40, 4, 25, 'first'), (9, 40, 5, 1, 'second'), (9, 40, 5, 2, 'third');
  `);
}

beforeEach(async () => seedPassage(client));

afterAll(async () => client.close());

describe('canonical Assistant passage resolution', () => {
  it('returns the complete ordered cross-chapter pericope from real Drizzle queries', async () => {
    await expect(resolveCanonicalPassage(input)).resolves.toMatchObject({
      sourceBible: 'Canonical Source',
      sourceLanguageCode: 'eng',
      verses: [
        { bookCode: 'MAT', chapter: 4, verse: 25, text: 'first' },
        { bookCode: 'MAT', chapter: 5, verse: 1, text: 'second' },
        { bookCode: 'MAT', chapter: 5, verse: 2, text: 'third' },
      ],
    });
  });

  it('binds source identity and exact pericope membership independently of the active interior verse', async () => {
    const first = await resolveCanonicalPassage(input);
    const interior = await resolveCanonicalPassage({ ...input, chapter: 5, activeVerse: 1 });
    expect(interior).toEqual(first);
    expect(first?.integritySource).toMatchObject({
      sourceBibleId: 9,
      organizationId: 1,
      textResourceId: null,
      provider: null,
      externalId: null,
      pericopeSetId: 3,
      membership: { number: '12', section: null },
    });
    await client.exec(
      `UPDATE pericope_verses SET pericope_number = '13' WHERE pericope_number = '12'`
    );
    const changedMembership = await resolveCanonicalPassage(input);
    expect(changedMembership?.verses).toEqual(first?.verses);
    expect(changedMembership?.integritySource).not.toEqual(first?.integritySource);
    await client.exec(`
      INSERT INTO bible_provider_resources (id, provider, external_id) VALUES (101, 'dbl', 'new-edition');
      UPDATE bibles SET text_resource_id = 101 WHERE id = 9;
    `);
    const changedBible = await resolveCanonicalPassage(input);
    expect(changedBible?.integritySource).not.toEqual(changedMembership?.integritySource);
  });

  it.each([false, true])(
    'binds selected text FK on %s contracted schema, preserving unlinked local verses',
    async (contracted) => {
      const database = new PGlite();
      const previous = databaseState.db;
      try {
        databaseState.db = drizzle(database, { schema });
        await migrate(drizzle(database), {
          migrationsFolder: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
        });
        if (contracted) await contractCatalogFixture(database);
        await seedPassage(database);
        const revision = (passage: Awaited<ReturnType<typeof resolveCanonicalPassage>>) =>
          integrityDigest('source-revision', passage?.integritySource);
        const unlinked = await resolveCanonicalPassage(input);
        expect(unlinked?.verses).toHaveLength(3);
        expect(unlinked?.integritySource).toMatchObject({
          textResourceId: null,
          provider: null,
          externalId: null,
        });
        const initialRevision = revision(unlinked);
        await database.exec(`
        INSERT INTO bible_provider_resources (id, provider, external_id)
        VALUES (101, 'dbl', 'shared-id'), (102, 'aquifer', 'shared-id'),
               (103, 'dbl', 'replacement');
        UPDATE bibles SET text_resource_id = 102 WHERE id = 9;
      `);
        const linked = await resolveCanonicalPassage(input);
        expect(linked?.integritySource).toMatchObject({
          textResourceId: 102,
          provider: 'aquifer',
          externalId: 'shared-id',
        });
        expect(revision(linked)).not.toBe(initialRevision);
        await database.exec(`UPDATE bibles SET audio_resource_id = 101 WHERE id = 9`);
        const audioChanged = await resolveCanonicalPassage(input);
        expect(revision(audioChanged)).toBe(revision(linked));
        await database.exec(`UPDATE bibles SET text_resource_id = 101 WHERE id = 9`);
        const collided = await resolveCanonicalPassage(input);
        expect(collided?.integritySource).toMatchObject({
          textResourceId: 101,
          provider: 'dbl',
          externalId: 'shared-id',
        });
        expect(revision(collided)).not.toBe(revision(linked));
        await database.exec(`UPDATE bibles SET text_resource_id = 103 WHERE id = 9`);
        const replaced = await resolveCanonicalPassage(input);
        expect(revision(replaced)).not.toBe(revision(collided));
        await database.exec(`UPDATE bibles SET text_resource_id = NULL WHERE id = 9`);
        const cleared = await resolveCanonicalPassage(input);
        expect(revision(cleared)).toBe(initialRevision);
        expect(cleared?.verses).toEqual(unlinked?.verses);
        await database.exec(`UPDATE projects SET pericope_set_id = NULL WHERE id = 7`);
        expect((await resolveCanonicalPassage(input))?.integritySource).toMatchObject({
          textResourceId: null,
          provider: null,
          externalId: null,
        });
        expect((await resolveCanonicalPassage(input))?.verses).toHaveLength(1);
      } finally {
        databaseState.db = previous;
        await database.close();
      }
    },
    60_000
  );

  it('rejects canonical context without a project source-language code', async () => {
    await client.exec(`UPDATE languages SET lang_code_iso_639_3 = NULL WHERE id = 1`);
    await expect(resolveCanonicalPassage(input)).resolves.toBeNull();
  });

  it('fails before generation when any canonical source verse is missing', async () => {
    await client.exec(`DELETE FROM bible_texts WHERE chapter_number = 5 AND verse_number = 1`);
    await expect(resolveCanonicalPassage(input)).resolves.toBeNull();
  });

  it('uses only the exact source verse when the project has no pericope set', async () => {
    await client.exec(`UPDATE projects SET pericope_set_id = NULL WHERE id = 7`);
    await expect(resolveCanonicalPassage(input)).resolves.toMatchObject({
      verses: [{ bookCode: 'MAT', chapter: 4, verse: 25, text: 'first' }],
    });
  });

  it('uses the exact source verse when no pericope covers the active verse', async () => {
    await client.exec(`DELETE FROM pericope_verses`);
    await expect(resolveCanonicalPassage(input)).resolves.toMatchObject({
      verses: [{ bookCode: 'MAT', chapter: 4, verse: 25, text: 'first' }],
    });
  });

  it('rejects a missing exact fallback verse', async () => {
    await client.exec(`
      UPDATE projects SET pericope_set_id = NULL WHERE id = 7;
      DELETE FROM bible_texts WHERE chapter_number = 4 AND verse_number = 25;
    `);
    await expect(resolveCanonicalPassage(input)).resolves.toBeNull();
  });
});

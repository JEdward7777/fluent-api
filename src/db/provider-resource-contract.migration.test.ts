import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contractCatalogFixture } from './testing/contract-catalog-fixture';
import { migrationStatements } from './testing/create-catalogue-schema';
import {
  createResourceLinkLegacyFixture,
  expandResourceLinks,
} from './testing/provider-resource-link-fixture';

let client: PGlite;
const query = async (sql: string) => (await client.query<Record<string, unknown>>(sql)).rows;
const revision = () => query('SELECT updated_at FROM catalogue_watermark');
beforeEach(async () => {
  client = new PGlite();
  await createResourceLinkLegacyFixture(client);
  await expandResourceLinks(client);
  for (const statement of migrationStatements('0047_canonical_resource_watermarks.sql'))
    await client.exec(statement);
  for (const provider of ['dbl', 'aquifer', 'youversion']) {
    await client.query(
      `INSERT INTO bible_provider_resources(provider,external_id,tts_license_status,recording_license_notice,text_license_notice,display_name,has_audio,extension)
      VALUES($1,'retained','forbidden','Recording','Text','Curated label',true,'{"unowned":true}')`,
      [provider]
    );
    await client.query(
      `INSERT INTO bibles(name,abbreviation,text_resource_id,audio_resource_id)
      SELECT $1,$2,id,id FROM bible_provider_resources WHERE provider=$3 AND external_id='retained'`,
      [provider, provider, provider]
    );
  }
  await client.exec(`INSERT INTO bibles(name,abbreviation,audio_resource_id)
    SELECT 'Seed','SEED',id FROM bible_provider_resources WHERE provider='aquifer'`);
}, 30000);
afterEach(() => client.close());

const ownedRows = async () => ({
  bibles: await query(
    'SELECT id,name,abbreviation,language_id,text_resource_id,audio_resource_id,created_at,updated_at FROM bibles ORDER BY id'
  ),
  resources: await query(
    'SELECT id,provider,external_id,tts_license_status,recording_license_notice,text_license_notice,display_name,has_audio,extension FROM bible_provider_resources ORDER BY id'
  ),
  classifications: await query('SELECT * FROM license_classifications'),
  revision: await revision(),
});

describe('actual release-3 catalog contract migration', () => {
  it('preserves every canonical fact, NULL link, unowned metadata, policy and watermark while removing the complete compatibility inventory', async () => {
    const before = await ownedRows();
    await contractCatalogFixture(client);
    expect(await ownedRows()).toEqual(before);
    const columns =
      await query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND
      ((table_name='bibles' AND column_name IN ('provider','external_id','has_audio')) OR (table_name='bible_provider_resources' AND column_name='license_notice'))`);
    expect(columns).toEqual([]);
    expect(await query("SELECT typname FROM pg_type WHERE typname='bible_provider'")).toEqual([]);
    expect(
      await query(
        "SELECT indexname FROM pg_indexes WHERE indexname='idx_bibles_provider_external_id'"
      )
    ).toEqual([]);
    expect(
      await query(
        "SELECT proname FROM pg_proc WHERE proname IN ('bridge_bible_text_resource','bridge_legacy_bible_audio','bridge_recording_license_notice','lock_catalog_bridge_writer')"
      )
    ).toEqual([]);
    expect(
      await query(
        "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND (tgname LIKE 'trg_bridge_%' OR tgname LIKE 'trg_lock_%')"
      )
    ).toEqual([]);
    expect(
      await query("SELECT proname FROM pg_proc WHERE proname='lock_canonical_catalog_writer'")
    ).toHaveLength(1);
    expect(
      await query(
        "SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_order_canonical_bible_writes','trg_order_canonical_resource_writes')"
      )
    ).toHaveLength(2);
    const [trigger] = await query(
      "SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgname='trg_bump_bibles_on_provider_resource_license'"
    );
    expect(trigger).toMatchObject({
      definition: expect.stringContaining('recording_license_notice'),
    });
    expect(trigger).toMatchObject({ definition: expect.stringContaining('text_license_notice') });
    expect(JSON.stringify(trigger)).not.toMatch(/\Wlicense_notice\W/);
  });

  it.each([
    ['tts_license_status', "'allowed'"],
    ['recording_license_notice', "'Changed recording'"],
    ['text_license_notice', "'Changed text'"],
    ['display_name', "'New label'"],
    ['external_id', "'new-id'"],
    ['provider', "'youversion'"],
    ['has_audio', 'false'],
  ])(
    'invalidates canonical text/recording links for %s and preserves no-op/rollback semantics',
    async (column, value) => {
      await contractCatalogFixture(client);
      if (column === 'provider')
        await client.exec(
          "UPDATE bible_provider_resources SET external_id='provider-move-unique' WHERE provider='aquifer'"
        );
      // Aquifer has both a text Bible and an unlinked seed selecting it as recording.
      const before = await query('SELECT id,updated_at FROM bibles ORDER BY id');
      const resource = "SELECT id FROM bible_provider_resources WHERE provider='aquifer'";
      await client.exec(
        `UPDATE bible_provider_resources SET ${column}=${value} WHERE id=(${resource})`
      );
      const after = await query('SELECT id,updated_at FROM bibles ORDER BY id');
      for (let index = 0; index < before.length; index++) {
        if (index === 1 || index === 3)
          expect(after[index].updated_at).not.toEqual(before[index].updated_at);
        else expect(after[index]).toEqual(before[index]);
      }
      const watermark = await revision();
      // Identify by stable FK even after a provider or external ID edit.
      const target = "SELECT text_resource_id FROM bibles WHERE abbreviation='aquifer'";
      await client.exec(
        `UPDATE bible_provider_resources SET ${column}=${value} WHERE id=(${target})`
      );
      expect(await query('SELECT id,updated_at FROM bibles ORDER BY id')).toEqual(after);
      expect(await revision()).toEqual(watermark);
      const snapshot = await ownedRows();
      await expect(
        client.transaction(async (tx) => {
          await tx.exec(
            `UPDATE bible_provider_resources SET text_license_notice='Rollback' WHERE id=(${target})`
          );
          throw new Error('rollback');
        })
      ).rejects.toThrow('rollback');
      expect(await ownedRows()).toEqual(snapshot);
    }
  );

  it('rolls back the entire DDL contract, then supports a clean successful migration', async () => {
    const before = await ownedRows();
    await expect(
      client.transaction(async (tx) => {
        for (const statement of migrationStatements('0048_license_identity_contract.sql'))
          await tx.exec(statement);
        throw new Error('migration failure');
      })
    ).rejects.toThrow('migration failure');
    expect(await ownedRows()).toEqual(before);
    expect(
      await query("SELECT proname FROM pg_proc WHERE proname='lock_catalog_bridge_writer'")
    ).toHaveLength(1);
    await client.exec("UPDATE bibles SET has_audio=false WHERE abbreviation='dbl'");
    expect(
      (await query("SELECT has_audio FROM bible_provider_resources WHERE provider='dbl'"))[0]
    ).toEqual({ has_audio: false });
    await contractCatalogFixture(client);
    await expect(
      client.exec("UPDATE bibles SET provider='dbl' WHERE abbreviation='dbl'")
    ).rejects.toThrow('does not exist');
  });
});

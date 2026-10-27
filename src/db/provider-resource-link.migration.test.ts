import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createResourceLinkLegacyFixture,
  expandResourceLinks,
} from './testing/provider-resource-link-fixture';

let client: PGlite;
beforeEach(async () => {
  client = new PGlite();
  await createResourceLinkLegacyFixture(client);
}, 30000);
afterEach(() => client.close());
const query = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await client.query<T>(sql, params)).rows;
const providers = ['dbl', 'aquifer', 'youversion'] as const;

describe('text resource expand migration', () => {
  it('backfills every provider without changing policy, notices, labels, extension metadata or catalog revisions, and leaves null seeds unlinked', async () => {
    for (const provider of providers) {
      await client.query(
        `INSERT INTO bible_provider_resources(provider,external_id,tts_license_status,license_notice,text_license_notice,display_name,extension)
        VALUES ($1,'existing','forbidden','Recording attribution','Text terms','Curated label','{"retained":true}')`,
        [provider]
      );
      await client.query(
        `INSERT INTO bibles(name,abbreviation,provider,external_id,has_audio,updated_at)
        VALUES ($1,$2,$3,'existing',true,'2026-10-01'),($4,$5,$3,'missing',false,'2026-10-02')`,
        [`${provider} existing`, `${provider}E`, provider, `${provider} missing`, `${provider}M`]
      );
    }
    await client.exec(
      `INSERT INTO bibles(name,abbreviation,provider,external_id,has_audio,updated_at) VALUES ('Seed','SEED','youversion',NULL,true,'2026-10-03')`
    );
    const resources = await query('SELECT * FROM bible_provider_resources ORDER BY id');
    const bibles = await query('SELECT * FROM bibles ORDER BY id');
    const classifications = await query('SELECT * FROM license_classifications');
    const watermark = await query('SELECT * FROM catalogue_watermark');
    await expandResourceLinks(client);
    expect(await query('SELECT * FROM catalogue_watermark')).toEqual(watermark);
    expect(await query('SELECT * FROM license_classifications')).toEqual(classifications);
    expect(
      await query(
        'SELECT id,language_id,name,abbreviation,provider,external_id,has_audio,audio_resource_id,created_at,updated_at FROM bibles ORDER BY id'
      )
    ).toEqual(bibles);
    expect(
      await query(
        `SELECT id,provider,external_id,tts_license_status,license_notice,recording_license_notice,text_license_notice,display_name,extension FROM bible_provider_resources WHERE external_id='existing' ORDER BY id`
      )
    ).toEqual(resources);
    const linked = await query(
      `SELECT b.provider,b.external_id,b.has_audio,r.has_audio AS resource_audio FROM bibles b JOIN bible_provider_resources r ON r.id=b.text_resource_id ORDER BY b.id`
    );
    expect(linked).toHaveLength(6);
    expect(linked.every((row) => row.has_audio === row.resource_audio)).toBe(true);
    expect(
      await query(`SELECT text_resource_id,has_audio FROM bibles WHERE abbreviation='SEED'`)
    ).toEqual([{ text_resource_id: null, has_audio: true }]);
    expect(
      await query(
        `SELECT tts_license_status,recording_license_notice,text_license_notice FROM bible_provider_resources WHERE external_id='missing'`
      )
    ).toEqual(
      providers.map(() => ({
        tts_license_status: 'unknown',
        recording_license_notice: null,
        text_license_notice: null,
      }))
    );
  });
});

interface LinkedBible {
  id: number;
  provider: string;
  external_id: string | null;
  has_audio: boolean;
  text_resource_id: number | null;
  audio_resource_id: number | null;
  name: string;
  abbreviation: string;
  updated_at: string;
}
const bible = async (abbreviation: string) =>
  (
    await query<LinkedBible>(
      `SELECT id,provider,external_id,has_audio,text_resource_id,audio_resource_id,name,abbreviation,updated_at::text FROM bibles WHERE abbreviation=$1`,
      [abbreviation]
    )
  )[0]!;
const revision = async () =>
  (
    await query<{ revision: string }>(
      'SELECT updated_at::text AS revision FROM catalogue_watermark'
    )
  )[0]!.revision;
const pinRevision = () => client.exec("UPDATE catalogue_watermark SET updated_at='2099-01-01'");
const revisionSteps = async () =>
  (
    await query<{ steps: number }>(
      "SELECT (extract(epoch FROM updated_at - timestamp '2099-01-01')*1000)::integer AS steps FROM catalogue_watermark"
    )
  )[0]!.steps;

describe('old and new text resource writers through the bridge', () => {
  it.each(providers)(
    'links old %s inserts/identity edits, forwards only distinct legacy audio, and keeps genuine no-ops revision-free',
    async (provider) => {
      await expandResourceLinks(client);
      await client.query(
        `INSERT INTO bibles(name,abbreviation,provider,external_id,has_audio) VALUES ('Legacy runtime','RUN',$1,'runtime',true)`,
        [provider]
      );
      const inserted = await bible('RUN');
      expect(inserted.text_resource_id).not.toBeNull();
      expect(
        await query(
          'SELECT provider,external_id,has_audio,tts_license_status FROM bible_provider_resources'
        )
      ).toEqual([
        { provider, external_id: 'runtime', has_audio: true, tts_license_status: 'unknown' },
      ]);
      await pinRevision();
      await client.exec("UPDATE bibles SET has_audio=false WHERE abbreviation='RUN'");
      expect(await revisionSteps()).toBe(1);
      expect((await query('SELECT has_audio FROM bible_provider_resources'))[0]!.has_audio).toBe(
        false
      );
      const beforeNoop = await bible('RUN');
      const beforeRevision = await revision();
      await client.exec(`UPDATE bibles SET provider=provider,external_id=external_id,has_audio=has_audio,text_resource_id=text_resource_id WHERE abbreviation='RUN';
      UPDATE bible_provider_resources SET provider=provider,external_id=external_id,has_audio=has_audio,recording_license_notice=recording_license_notice,text_license_notice=text_license_notice;`);
      expect(await bible('RUN')).toEqual(beforeNoop);
      expect(await revision()).toBe(beforeRevision);
      await client.query(
        `INSERT INTO bible_provider_resources(provider,external_id,has_audio,tts_license_status,display_name) VALUES($1,'existing-relink',true,'forbidden','Retained relink metadata')`,
        [provider]
      );
      await client.exec("UPDATE bibles SET external_id='existing-relink' WHERE abbreviation='RUN'");
      expect((await bible('RUN')).has_audio).toBe(true);
      expect(
        await query(
          "SELECT has_audio,tts_license_status,display_name FROM bible_provider_resources WHERE external_id='existing-relink'"
        )
      ).toEqual([
        {
          has_audio: true,
          tts_license_status: 'forbidden',
          display_name: 'Retained relink metadata',
        },
      ]);
      await client.exec("UPDATE bibles SET external_id='replacement' WHERE abbreviation='RUN'");
      const replacement = await bible('RUN');
      expect(replacement.text_resource_id).not.toBe(inserted.text_resource_id);
      expect(replacement.external_id).toBe('replacement');
      expect(replacement.provider).toBe(provider);
      expect(replacement.updated_at > beforeNoop.updated_at).toBe(true);
      expect(await query('SELECT * FROM license_classifications')).toHaveLength(1);
    }
  );

  it.each(providers)(
    'copies %s canonical FK facts over INSERT defaults, rejects contradictions, and clears links without touching selected recordings',
    async (provider) => {
      const secondProvider = provider === 'youversion' ? 'dbl' : 'youversion';
      await expandResourceLinks(client);
      const [first] = await query<{ id: number }>(
        `INSERT INTO bible_provider_resources(provider,external_id,has_audio,tts_license_status,display_name,license_notice,text_license_notice)
      VALUES ($1,'first',true,'forbidden','Curated first','Recording notice','Text notice') RETURNING id`,
        [provider]
      );
      const [second] = await query<{ id: number }>(
        `INSERT INTO bible_provider_resources(provider,external_id,has_audio,tts_license_status,display_name)
      VALUES ($1,'second',false,'allowed','Curated second') RETURNING id`,
        [secondProvider]
      );
      const [sameAudio] = await query<{ id: number }>(
        `INSERT INTO bible_provider_resources(provider,external_id,has_audio) VALUES($1,'same-audio',true) RETURNING id`,
        [provider]
      );
      await client.exec(`CREATE TABLE resource_write_audit (event text);
      CREATE FUNCTION audit_resource_write() RETURNS trigger AS $$ BEGIN INSERT INTO resource_write_audit VALUES(TG_OP); RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER zz_audit_resource_write AFTER INSERT OR UPDATE ON bible_provider_resources FOR EACH ROW EXECUTE FUNCTION audit_resource_write();`);
      await client.query(
        `INSERT INTO bibles(name,abbreviation,text_resource_id,audio_resource_id) VALUES ('Canonical','CAN',$1,$2)`,
        [first!.id, second!.id]
      );
      expect(await bible('CAN')).toMatchObject({
        provider,
        external_id: 'first',
        has_audio: true,
        text_resource_id: first!.id,
        audio_resource_id: second!.id,
      });
      expect(await query('SELECT * FROM resource_write_audit')).toEqual([]);
      await expect(
        client.query(
          `INSERT INTO bibles(name,abbreviation,provider,external_id,text_resource_id) VALUES ('Contradiction','BAD','dbl','different',$1)`,
          [second!.id]
        )
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.exec(
          "INSERT INTO bibles(name,abbreviation,text_resource_id) VALUES ('Missing','MISS',999999)"
        )
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        client.query(
          `UPDATE bibles SET text_resource_id=$1,provider='dbl',external_id='contradiction' WHERE abbreviation='CAN'`,
          [second!.id]
        )
      ).rejects.toMatchObject({ code: '23514' });
      const beforeConflict = await revision();
      await expect(
        client.query(
          `UPDATE bibles SET text_resource_id=$1,has_audio=false WHERE abbreviation='CAN'`,
          [sameAudio!.id]
        )
      ).rejects.toMatchObject({ code: '23514' });
      expect(await revision()).toBe(beforeConflict);
      await client.query(`UPDATE bibles SET text_resource_id=$1 WHERE abbreviation='CAN'`, [
        second!.id,
      ]);
      expect(await bible('CAN')).toMatchObject({
        provider: secondProvider,
        external_id: 'second',
        has_audio: false,
        audio_resource_id: second!.id,
      });
      expect(await query('SELECT * FROM resource_write_audit')).toEqual([]);
      await client.exec("UPDATE bibles SET text_resource_id=NULL WHERE abbreviation='CAN'");
      expect(await bible('CAN')).toMatchObject({
        text_resource_id: null,
        external_id: null,
        has_audio: false,
        audio_resource_id: second!.id,
      });
      expect(await query('SELECT * FROM resource_write_audit')).toEqual([]);
      await client.query(
        `INSERT INTO bibles(name,abbreviation,text_resource_id) VALUES ('Restriction','REST',$1)`,
        [first!.id]
      );
      await expect(
        client.query('DELETE FROM bible_provider_resources WHERE id=$1', [first!.id])
      ).rejects.toThrow('bibles_text_resource_id_bible_provider_resources_id_fk');
      await expect(
        client.query(
          `INSERT INTO bibles(name,abbreviation,text_resource_id) VALUES ('Duplicate','DUP',$1)`,
          [first!.id]
        )
      ).rejects.toMatchObject({ code: '23505' });
    }
  );

  it.each(providers)(
    'reflects %s resource identity/audio once, preserving labels/policy/notices and null-identity recording watermarks',
    async (provider) => {
      const renamedProvider =
        provider === 'dbl' ? 'aquifer' : provider === 'aquifer' ? 'youversion' : 'dbl';
      await expandResourceLinks(client);
      const [resource] = await query<{ id: number }>(
        `INSERT INTO bible_provider_resources(provider,external_id,has_audio,tts_license_status,license_notice,text_license_notice,display_name,extension)
      VALUES ($1,'original',false,'forbidden','Recording attribution','Text terms','Curated resource','{"keep":true}') RETURNING id`,
        [provider]
      );
      await client.query(
        `INSERT INTO bibles(name,abbreviation,text_resource_id) VALUES ('Fluent label','TEXT',$1)`,
        [resource!.id]
      );
      await client.query(
        `INSERT INTO bibles(name,abbreviation,audio_resource_id) VALUES ('Seed recording listener','SEED',$1)`,
        [resource!.id]
      );
      const before = await bible('TEXT');
      const listener = await bible('SEED');
      await client.exec(`CREATE TABLE resource_write_audit (event text);
      CREATE FUNCTION audit_resource_write() RETURNS trigger AS $$ BEGIN INSERT INTO resource_write_audit VALUES(TG_OP); RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER zz_audit_resource_write AFTER INSERT OR UPDATE ON bible_provider_resources FOR EACH ROW EXECUTE FUNCTION audit_resource_write();`);
      await pinRevision();
      await client.query(
        `UPDATE bible_provider_resources SET provider=$2,external_id='renamed',has_audio=true WHERE id=$1`,
        [resource!.id, renamedProvider]
      );
      expect(await query('SELECT * FROM resource_write_audit')).toEqual([{ event: 'UPDATE' }]);
      expect(await bible('TEXT')).toMatchObject({
        provider: renamedProvider,
        external_id: 'renamed',
        has_audio: true,
        name: 'Fluent label',
        abbreviation: 'TEXT',
        text_resource_id: resource!.id,
      });
      expect((await bible('TEXT')).updated_at > before.updated_at).toBe(true);
      expect((await bible('SEED')).updated_at > listener.updated_at).toBe(true);
      expect((await bible('SEED')).text_resource_id).toBeNull();
      expect(await revisionSteps()).toBe(2);
      expect(
        await query(
          `SELECT tts_license_status,recording_license_notice,text_license_notice,display_name,extension FROM bible_provider_resources WHERE id=${resource!.id}`
        )
      ).toEqual([
        {
          tts_license_status: 'forbidden',
          recording_license_notice: 'Recording attribution',
          text_license_notice: 'Text terms',
          display_name: 'Curated resource',
          extension: { keep: true },
        },
      ]);
      await client.query(`UPDATE bible_provider_resources SET has_audio=false WHERE id=$1`, [
        resource!.id,
      ]);
      expect((await bible('TEXT')).has_audio).toBe(false);
      expect(await revisionSteps()).toBe(4);
    }
  );

  it('rolls back resource/Bible reflections and the revision allocator together', async () => {
    await expandResourceLinks(client);
    await client.exec(
      "INSERT INTO bibles(name,abbreviation,provider,external_id) VALUES ('Rollback','ROLL','dbl','rollback')"
    );
    const beforeBible = await query('SELECT * FROM bibles');
    const beforeResources = await query('SELECT * FROM bible_provider_resources');
    const beforeRevision = await revision();
    await expect(
      client.transaction(async (tx) => {
        await tx.exec(
          "UPDATE bibles SET has_audio=true WHERE abbreviation='ROLL'; UPDATE bible_provider_resources SET provider='aquifer',external_id='changed'"
        );
        throw new Error('Roll back the complete bridge operation');
      })
    ).rejects.toThrow('Roll back the complete bridge operation');
    expect(await query('SELECT * FROM bibles')).toEqual(beforeBible);
    expect(await query('SELECT * FROM bible_provider_resources')).toEqual(beforeResources);
    expect(await revision()).toBe(beforeRevision);
  });
});

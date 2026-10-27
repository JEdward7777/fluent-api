import type postgres from 'postgres';

import { expect, it } from 'vitest';

import { migrationStatements } from './create-catalogue-schema';

interface LinkedBible {
  id: number;
  provider: string;
  external_id: string | null;
  has_audio: boolean;
  text_resource_id: number | null;
  audio_resource_id: number | null;
  updated_at: Date;
}

/** Registers after the release-1 cases in the same guarded disposable PostgreSQL suite. */
export function registerResourceLinkCases(sql: postgres.Sql) {
  const readBible = async (abbreviation: string) =>
    (
      await sql<LinkedBible[]>`
    SELECT id,provider::text,external_id,has_audio,text_resource_id,audio_resource_id,updated_at
    FROM bibles WHERE abbreviation=${abbreviation}`
    )[0]!;
  const revision = async () =>
    (await sql<{ updated_at: Date }[]>`SELECT updated_at FROM catalogue_watermark`)[0]!.updated_at;
  const providers = ['dbl', 'aquifer', 'youversion'] as const;

  it('backfills the release-1 PostgreSQL catalog without changing policy, notices, labels, classifications, or revisions', async () => {
    for (const provider of providers) {
      await sql`INSERT INTO bible_provider_resources(provider,external_id,tts_license_status,license_notice,text_license_notice,display_name)
        VALUES (${provider},'link-existing','forbidden','Recording','Text','Curated label')`;
      await sql`INSERT INTO bibles(language_id,name,abbreviation,provider,external_id,has_audio)
        VALUES (1,${`Link existing ${provider}`},${`LE-${provider}`},${provider},'link-existing',true),
          (1,${`Link missing ${provider}`},${`LM-${provider}`},${provider},'link-missing',false)`;
    }
    await sql`INSERT INTO bibles(language_id,name,abbreviation,provider,external_id,has_audio) VALUES(1,'Link null seed','L-SEED','youversion',NULL,true)`;
    await sql`INSERT INTO license_classifications(normalized_text,status,rationale,classified_by) VALUES('link retained','unknown','"Review retained"'::jsonb,'human')`;
    const beforeBibles =
      await sql`SELECT id,provider,external_id,has_audio,name,abbreviation,audio_resource_id,updated_at FROM bibles ORDER BY id`;
    const beforeResources =
      await sql`SELECT id,provider,external_id,tts_license_status,license_notice,recording_license_notice,text_license_notice,display_name FROM bible_provider_resources ORDER BY id`;
    const beforeClasses = await sql`SELECT * FROM license_classifications ORDER BY normalized_text`;
    const beforeRevision = await revision();
    await sql.begin(async (tx) => {
      for (const statement of migrationStatements('0046_provider_resource_link_bridge.sql'))
        await tx.unsafe(statement);
    });
    expect(
      await sql`SELECT id,provider,external_id,has_audio,name,abbreviation,audio_resource_id,updated_at FROM bibles ORDER BY id`
    ).toEqual(beforeBibles);
    expect(
      await sql`SELECT id,provider,external_id,tts_license_status,license_notice,recording_license_notice,text_license_notice,display_name FROM bible_provider_resources WHERE external_id <> 'link-missing' ORDER BY id`
    ).toEqual(beforeResources);
    expect(await sql`SELECT * FROM license_classifications ORDER BY normalized_text`).toEqual(
      beforeClasses
    );
    expect(await revision()).toEqual(beforeRevision);
    expect(
      (await sql`SELECT text_resource_id FROM bibles WHERE abbreviation='L-SEED'`)[0]!
        .text_resource_id
    ).toBeNull();
    expect(
      await sql`SELECT b.id FROM bibles b JOIN bible_provider_resources r ON r.id=b.text_resource_id WHERE b.has_audio IS DISTINCT FROM r.has_audio`
    ).toEqual([]);
    expect(
      await sql`SELECT id FROM bibles WHERE external_id IS NOT NULL AND text_resource_id IS NULL`
    ).toEqual([]);
  });

  it.each(providers)(
    'supports old %s and FK-only PostgreSQL writers, canonical resource reflection, null unlink and rollback',
    async (provider) => {
      const oldKey = `link-runtime-${provider}`;
      const oldAbbreviation = `LR-${provider}`;
      await sql`INSERT INTO bibles(language_id,name,abbreviation,provider,external_id,has_audio)
      VALUES (1,${`Link runtime ${provider}`},${oldAbbreviation},${provider},${oldKey},true)`;
      const old = await readBible(oldAbbreviation);
      expect(old.provider).toBe(provider);
      expect(old.text_resource_id).not.toBeNull();
      const [resource] = await sql<
        { id: number }[]
      >`INSERT INTO bible_provider_resources(provider,external_id,has_audio,tts_license_status,display_name)
      VALUES (${provider},${`link-canonical-${provider}`},true,'forbidden','Canonical curated') RETURNING id`;
      const canonicalAbbreviation = `LC-${provider}`;
      await sql`INSERT INTO bibles(language_id,name,abbreviation,text_resource_id,audio_resource_id)
      VALUES (1,${`Link canonical ${provider}`},${canonicalAbbreviation},${resource!.id},${old.text_resource_id})`;
      expect(await readBible(canonicalAbbreviation)).toMatchObject({
        provider,
        external_id: `link-canonical-${provider}`,
        has_audio: true,
        text_resource_id: resource!.id,
        audio_resource_id: old.text_resource_id,
      });
      const beforeNoop = await readBible(oldAbbreviation);
      const beforeRevision = await revision();
      await sql`UPDATE bibles SET provider=provider,external_id=external_id,has_audio=has_audio,text_resource_id=text_resource_id WHERE id=${old.id}`;
      await sql`UPDATE bible_provider_resources SET provider=provider,external_id=external_id,has_audio=has_audio WHERE id=${old.text_resource_id}`;
      expect(await readBible(oldAbbreviation)).toEqual(beforeNoop);
      expect(await revision()).toEqual(beforeRevision);
      await sql`UPDATE bibles SET has_audio=false WHERE id=${old.id}`;
      expect(
        (
          await sql`SELECT has_audio FROM bible_provider_resources WHERE id=${old.text_resource_id}`
        )[0]!.has_audio
      ).toBe(false);
      const renamedProvider =
        provider === 'dbl' ? 'aquifer' : provider === 'aquifer' ? 'youversion' : 'dbl';
      await sql`UPDATE bible_provider_resources SET provider=${renamedProvider},external_id=${`link-renamed-${provider}`},has_audio=false WHERE id=${resource!.id}`;
      expect(await readBible(canonicalAbbreviation)).toMatchObject({
        provider: renamedProvider,
        external_id: `link-renamed-${provider}`,
        has_audio: false,
        text_resource_id: resource!.id,
      });
      expect(
        (
          await sql`SELECT tts_license_status,display_name FROM bible_provider_resources WHERE id=${resource!.id}`
        )[0]
      ).toEqual({ tts_license_status: 'forbidden', display_name: 'Canonical curated' });
      const beforeAlias = await readBible(canonicalAbbreviation);
      await sql`UPDATE bible_provider_resources SET license_notice='Old binary recording edit',text_license_notice='Changed text' WHERE id=${resource!.id}`;
      expect((await readBible(canonicalAbbreviation)).updated_at.getTime()).toBeGreaterThan(
        beforeAlias.updated_at.getTime()
      );
      expect(
        (
          await sql`SELECT recording_license_notice FROM bible_provider_resources WHERE id=${resource!.id}`
        )[0]!.recording_license_notice
      ).toBe('Old binary recording edit');
      const beforeRollback = await readBible(canonicalAbbreviation);
      const rollbackRevision = await revision();
      await expect(
        sql.begin(async (tx) => {
          await tx`UPDATE bible_provider_resources SET has_audio=true WHERE id=${resource!.id}`;
          throw new Error('Reject bridge transaction');
        })
      ).rejects.toThrow('Reject bridge transaction');
      expect(await readBible(canonicalAbbreviation)).toEqual(beforeRollback);
      expect(await revision()).toEqual(rollbackRevision);
      await expect(
        sql`UPDATE bibles SET text_resource_id=${old.text_resource_id},external_id='conflicting',provider='dbl' WHERE abbreviation=${canonicalAbbreviation}`
      ).rejects.toMatchObject({ code: '23514' });
      await sql`UPDATE bibles SET text_resource_id=NULL WHERE abbreviation=${canonicalAbbreviation}`;
      expect(await readBible(canonicalAbbreviation)).toMatchObject({
        text_resource_id: null,
        external_id: null,
        has_audio: false,
        audio_resource_id: old.text_resource_id,
      });
      const recordingListener = await readBible(canonicalAbbreviation);
      await sql`UPDATE bible_provider_resources SET has_audio=true WHERE id=${old.text_resource_id}`;
      expect((await readBible(canonicalAbbreviation)).updated_at.getTime()).toBeGreaterThan(
        recordingListener.updated_at.getTime()
      );
      expect((await readBible(canonicalAbbreviation)).text_resource_id).toBeNull();
    }
  );
  it('serializes opposing ordinary legacy and canonical audio updates before tuple locks without deadlocks or lost toggles', async () => {
    const [resource] = await sql<
      { id: number }[]
    >`INSERT INTO bible_provider_resources(provider,external_id) VALUES('dbl','link-concurrent') RETURNING id`;
    const [linked] = await sql<
      { id: number }[]
    >`INSERT INTO bibles(language_id,name,abbreviation,text_resource_id) VALUES(1,'Link concurrent','L-CON',${resource!.id}) RETURNING id`;
    const legacy = await sql.reserve();
    const canonical = await sql.reserve();
    try {
      await legacy`SET statement_timeout='5s'`;
      await canonical`SET statement_timeout='5s'`;
      // No artificial ordering/locks/sleeps: these are the two supported ordinary statements.
      // Repetition exercises either winner, while every pair must perform two serial toggles.
      for (let pair = 0; pair < 40; pair++) {
        const results = await Promise.allSettled([
          legacy`UPDATE bibles SET has_audio=NOT has_audio,updated_at=next_catalogue_watermark() WHERE id=${linked!.id}`,
          canonical`UPDATE bible_provider_resources SET has_audio=NOT has_audio WHERE id=${resource!.id}`,
        ]);
        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(await readBible('L-CON')).toMatchObject({
          has_audio: false,
          text_resource_id: resource!.id,
        });
        expect(
          (await sql`SELECT has_audio FROM bible_provider_resources WHERE id=${resource!.id}`)[0]!
            .has_audio
        ).toBe(false);
      }
    } finally {
      await legacy`RESET statement_timeout`;
      await canonical`RESET statement_timeout`;
      legacy.release();
      canonical.release();
    }
  }, 30000);

  it('keeps canonical coarse-audio revisions commit-ordered across the bridge and an advancing cursor', async () => {
    const [resource] = await sql<
      { id: number }[]
    >`INSERT INTO bible_provider_resources(provider,external_id) VALUES('youversion','link-order') RETURNING id`;
    await sql`INSERT INTO bibles(language_id,name,abbreviation,text_resource_id) VALUES(1,'Link order','L-ORDER',${resource!.id})`;
    const early = await sql.reserve();
    const later = await sql.reserve();
    let committed = false;
    let pending: Promise<postgres.RowList<postgres.Row[]>> | undefined;
    try {
      await early`BEGIN`;
      const [cursorRow] = await sql<
        { updated_at: Date }[]
      >`INSERT INTO books(code,eng_display_name) VALUES('link-cursor','Cursor') RETURNING updated_at`;
      const cursor = cursorRow!.updated_at;
      await early`UPDATE bible_provider_resources SET has_audio=true WHERE id=${resource!.id}`;
      const changed = await early<
        { updated_at: Date }[]
      >`SELECT updated_at FROM bibles WHERE abbreviation='L-ORDER'`;
      expect(changed[0]!.updated_at.getTime()).toBeGreaterThan(cursor.getTime());
      const [connection] = await later<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      pending =
        later`INSERT INTO books(code,eng_display_name) VALUES('link-later','Later') RETURNING updated_at`.execute();
      await expect
        .poll(async () =>
          Number(
            (await sql`SELECT cardinality(pg_blocking_pids(${connection!.pid})) AS count`)[0]!.count
          )
        )
        .toBeGreaterThan(0);
      await early`COMMIT`;
      committed = true;
      const [newer] = await pending;
      expect((newer!.updated_at as Date).getTime()).toBeGreaterThan(
        changed[0]!.updated_at.getTime()
      );
      const visible = await sql<
        { updated_at: Date }[]
      >`SELECT updated_at FROM bibles WHERE abbreviation='L-ORDER' AND updated_at >= ${cursor}`;
      expect(visible[0]!.updated_at).toEqual(changed[0]!.updated_at);
    } finally {
      if (!committed) await early`ROLLBACK`;
      await pending?.catch(() => {});
      early.release();
      later.release();
    }
  });
}

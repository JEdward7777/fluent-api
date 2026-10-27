/** Test-only future contract: prove runtime SQL needs no rollback columns/helpers. */
export async function contractCatalogFixture(client: {
  exec: (query: string) => Promise<unknown>;
}) {
  await client.exec(`
    DROP TRIGGER trg_bridge_bible_text_resource ON bibles;
    DROP TRIGGER trg_bridge_legacy_bible_audio ON bibles;
    DROP TRIGGER trg_bridge_recording_license_notice ON bible_provider_resources;
    DROP TRIGGER trg_lock_bible_catalog_writer ON bibles;
    DROP TRIGGER trg_lock_resource_catalog_writer ON bible_provider_resources;
    DROP FUNCTION bridge_bible_text_resource();
    DROP FUNCTION bridge_legacy_bible_audio();
    DROP FUNCTION bridge_recording_license_notice();
    DROP FUNCTION lock_catalog_bridge_writer();
    DROP TRIGGER trg_bump_bibles_on_provider_resource_license ON bible_provider_resources;
    ALTER TABLE bibles DROP COLUMN provider, DROP COLUMN external_id, DROP COLUMN has_audio;
    ALTER TABLE bible_provider_resources DROP COLUMN license_notice;
    DROP TYPE bible_provider;
    CREATE OR REPLACE FUNCTION bump_linked_bibles_on_provider_resource_license()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT'
        OR NEW.tts_license_status IS DISTINCT FROM OLD.tts_license_status
        OR NEW.recording_license_notice IS DISTINCT FROM OLD.recording_license_notice
        OR NEW.text_license_notice IS DISTINCT FROM OLD.text_license_notice
        OR NEW.display_name IS DISTINCT FROM OLD.display_name
        OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.external_id IS DISTINCT FROM OLD.external_id
        OR NEW.has_audio IS DISTINCT FROM OLD.has_audio
      THEN
        UPDATE bibles SET updated_at = next_catalogue_watermark()
        WHERE text_resource_id = NEW.id OR audio_resource_id = NEW.id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER trg_bump_bibles_on_provider_resource_license
    AFTER INSERT OR UPDATE OF tts_license_status, recording_license_notice, text_license_notice,
      display_name, provider, external_id, has_audio ON bible_provider_resources
    FOR EACH ROW EXECUTE FUNCTION bump_linked_bibles_on_provider_resource_license();
  `);
}

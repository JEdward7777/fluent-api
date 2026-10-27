-- Release 2 is the rollback floor. Retire compatibility before removing its columns.
LOCK TABLE bibles, bible_provider_resources IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DROP TRIGGER trg_bridge_bible_text_resource ON bibles;
--> statement-breakpoint
DROP TRIGGER trg_bridge_legacy_bible_audio ON bibles;
--> statement-breakpoint
DROP TRIGGER trg_bridge_recording_license_notice ON bible_provider_resources;
--> statement-breakpoint
DROP TRIGGER trg_lock_bible_catalog_writer ON bibles;
--> statement-breakpoint
DROP TRIGGER trg_lock_resource_catalog_writer ON bible_provider_resources;
--> statement-breakpoint
DROP TRIGGER trg_bump_bibles_on_provider_resource_license ON bible_provider_resources;
--> statement-breakpoint
DROP FUNCTION bridge_bible_text_resource();
--> statement-breakpoint
DROP FUNCTION bridge_legacy_bible_audio();
--> statement-breakpoint
DROP FUNCTION bridge_recording_license_notice();
--> statement-breakpoint
DROP FUNCTION lock_catalog_bridge_writer();
--> statement-breakpoint
DROP INDEX "idx_bibles_provider_external_id";--> statement-breakpoint
ALTER TABLE "bible_provider_resources" DROP COLUMN "license_notice";--> statement-breakpoint
ALTER TABLE "bibles" DROP COLUMN "provider";--> statement-breakpoint
ALTER TABLE "bibles" DROP COLUMN "external_id";--> statement-breakpoint
ALTER TABLE "bibles" DROP COLUMN "has_audio";--> statement-breakpoint
DROP TYPE "public"."bible_provider";
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TRIGGER trg_bump_bibles_on_provider_resource_license
AFTER INSERT OR UPDATE OF tts_license_status, recording_license_notice, text_license_notice,
  display_name, provider, external_id, has_audio ON bible_provider_resources
FOR EACH ROW EXECUTE FUNCTION bump_linked_bibles_on_provider_resource_license();
--> statement-breakpoint
-- Canonical multi-row transactions still require a common lock before tuple
-- locks: a later resource/Bible writer must not hold a tuple while waiting for
-- a batch's revision lock. This is permanent catalog ordering, not a legacy
-- bridge. Reuse the existing singleton without advancing it or adding state.
CREATE FUNCTION lock_canonical_catalog_writer()
RETURNS trigger AS $$
BEGIN
  PERFORM id FROM public.catalogue_watermark WHERE id = true FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Catalogue watermark singleton is missing' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_order_canonical_bible_writes
BEFORE INSERT OR UPDATE OR DELETE ON bibles
FOR EACH STATEMENT EXECUTE FUNCTION lock_canonical_catalog_writer();
--> statement-breakpoint
CREATE TRIGGER trg_order_canonical_resource_writes
BEFORE INSERT OR UPDATE OR DELETE ON bible_provider_resources
FOR EACH STATEMENT EXECUTE FUNCTION lock_canonical_catalog_writer();

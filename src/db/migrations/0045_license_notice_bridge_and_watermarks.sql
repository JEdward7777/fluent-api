-- Expand before new binaries deploy. Existing policy and Bible watermarks are unchanged.
UPDATE bible_provider_resources
SET recording_license_notice = license_notice
WHERE recording_license_notice IS DISTINCT FROM license_notice;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bridge_recording_license_notice()
RETURNS trigger AS $$
DECLARE
  legacy_changed boolean;
  canonical_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.license_notice IS NOT NULL
      AND NEW.recording_license_notice IS NOT NULL
      AND NEW.license_notice IS DISTINCT FROM NEW.recording_license_notice
    THEN
      RAISE EXCEPTION 'Conflicting recording license notices' USING ERRCODE = '23514';
    END IF;
    IF NEW.recording_license_notice IS NULL THEN
      NEW.recording_license_notice := NEW.license_notice;
    ELSE
      NEW.license_notice := NEW.recording_license_notice;
    END IF;
  ELSE
    -- Row triggers observe changed values, not whether an unchanged/NULL value
    -- was explicitly included in the SQL target list. No sentinel state is needed.
    legacy_changed := NEW.license_notice IS DISTINCT FROM OLD.license_notice;
    canonical_changed := NEW.recording_license_notice IS DISTINCT FROM OLD.recording_license_notice;
    IF legacy_changed AND canonical_changed
      AND NEW.license_notice IS DISTINCT FROM NEW.recording_license_notice
    THEN
      RAISE EXCEPTION 'Conflicting recording license notices' USING ERRCODE = '23514';
    ELSIF legacy_changed THEN
      NEW.recording_license_notice := NEW.license_notice;
    ELSIF canonical_changed THEN
      NEW.license_notice := NEW.recording_license_notice;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_bridge_recording_license_notice
BEFORE INSERT OR UPDATE OF license_notice, recording_license_notice
ON bible_provider_resources
FOR EACH ROW EXECUTE FUNCTION bridge_recording_license_notice();
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
  THEN
    UPDATE bibles
    SET updated_at = next_catalogue_watermark()
    WHERE audio_resource_id = NEW.id
      OR (bibles.provider::text = NEW.provider::text AND bibles.external_id = NEW.external_id)
      OR (TG_OP = 'UPDATE' AND bibles.provider::text = OLD.provider::text AND bibles.external_id = OLD.external_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_bump_bibles_on_provider_resource_license ON bible_provider_resources;
--> statement-breakpoint
-- UPDATE OF inspects query targets, not columns changed by a BEFORE trigger.
-- Keep the legacy alias watched for every old-binary write throughout the bridge window.
CREATE TRIGGER trg_bump_bibles_on_provider_resource_license
AFTER INSERT OR UPDATE OF tts_license_status, license_notice, recording_license_notice, text_license_notice, display_name, provider, external_id
ON bible_provider_resources
FOR EACH ROW EXECUTE FUNCTION bump_linked_bibles_on_provider_resource_license();

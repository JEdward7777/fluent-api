-- Match legacy text identities for every provider; preserve the commit-ordered allocator.
CREATE OR REPLACE FUNCTION bump_linked_bibles_on_provider_resource_license()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT'
    OR NEW.tts_license_status IS DISTINCT FROM OLD.tts_license_status
    OR NEW.license_notice IS DISTINCT FROM OLD.license_notice
    OR NEW.display_name IS DISTINCT FROM OLD.display_name
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.external_id IS DISTINCT FROM OLD.external_id
  THEN
    UPDATE bibles
    SET updated_at = next_catalogue_watermark()
    WHERE audio_resource_id = NEW.id
      OR (
        bibles.provider::text = NEW.provider::text
        AND bibles.external_id = NEW.external_id
      )
      OR (
        TG_OP = 'UPDATE'
        AND bibles.provider::text = OLD.provider::text
        AND bibles.external_id = OLD.external_id
      );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

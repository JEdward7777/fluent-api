CREATE OR REPLACE FUNCTION bridge_bible_text_resource()
RETURNS trigger AS $$
DECLARE
  resource bible_provider_resources%ROWTYPE;
  fk_changed boolean;
  identity_changed boolean;
  audio_changed boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    fk_changed := NEW.text_resource_id IS DISTINCT FROM OLD.text_resource_id;
    identity_changed := NEW.external_id IS DISTINCT FROM OLD.external_id
      OR (NEW.external_id IS NOT NULL AND NEW.provider IS DISTINCT FROM OLD.provider);
    audio_changed := NEW.has_audio IS DISTINCT FROM OLD.has_audio;
    IF NOT (fk_changed OR identity_changed OR audio_changed) THEN RETURN NEW; END IF;
  ELSE
    fk_changed := NEW.text_resource_id IS NOT NULL;
    identity_changed := NEW.external_id IS NOT NULL;
    audio_changed := false;
  END IF;

  IF fk_changed THEN
    IF NEW.text_resource_id IS NULL THEN
      IF identity_changed AND NEW.external_id IS NOT NULL THEN
        RAISE EXCEPTION 'Conflicting text resource unlink and legacy identity' USING ERRCODE = '23514';
      END IF;
      -- Canonical unlink has no provider identity. Mirror the public seed fallback
      -- so a release-1 rollback returns the same response as FK-only readers.
      NEW.provider := 'dbl';
      NEW.external_id := NULL;
      NEW.has_audio := false;
    ELSE
      SELECT * INTO resource FROM bible_provider_resources WHERE id = NEW.text_resource_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Text resource % does not exist', NEW.text_resource_id USING ERRCODE = '23503';
      END IF;
      IF identity_changed AND (
        NEW.external_id IS DISTINCT FROM resource.external_id
        OR NEW.provider::text IS DISTINCT FROM resource.provider::text
      ) THEN
        RAISE EXCEPTION 'Conflicting text resource FK and legacy identity' USING ERRCODE = '23514';
      END IF;
      IF audio_changed AND NEW.has_audio IS DISTINCT FROM resource.has_audio THEN
        RAISE EXCEPTION 'Conflicting text resource FK and legacy audio fact' USING ERRCODE = '23514';
      END IF;
      -- INSERT cannot distinguish explicit legacy defaults from omitted values.
      -- With a supplied FK, the resource owns these facts; no policy is overwritten.
      NEW.provider := resource.provider::text::bible_provider;
      NEW.external_id := resource.external_id;
      NEW.has_audio := resource.has_audio;
    END IF;
  ELSIF NEW.external_id IS NULL THEN
    -- Null-identity seeds stay unlinked; their separately selected recording is untouched.
    NEW.text_resource_id := NULL;
  ELSE
    -- SELECT first: resource-to-Bible reflection must never re-upsert the resource
    -- tuple that is already inside its AFTER trigger.
    SELECT * INTO resource FROM bible_provider_resources
    WHERE provider::text = NEW.provider::text AND external_id = NEW.external_id;
    IF NOT FOUND THEN
      INSERT INTO bible_provider_resources (provider, external_id, display_name, has_audio)
      VALUES (NEW.provider::text::resource_provider, NEW.external_id, NEW.name, NEW.has_audio)
      ON CONFLICT (provider, external_id) DO NOTHING
      RETURNING * INTO resource;
      IF NOT FOUND THEN
        SELECT * INTO STRICT resource FROM bible_provider_resources
        WHERE provider::text = NEW.provider::text AND external_id = NEW.external_id;
      END IF;
    END IF;
    NEW.text_resource_id := resource.id;
    -- A legacy identity-only relink reads the selected resource's audio fact.
    -- Only a genuinely changed legacy audio value is forwarded by the AFTER bridge.
    IF TG_OP = 'UPDATE' AND identity_changed AND NOT audio_changed THEN
      NEW.has_audio := resource.has_audio;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.text_resource_id IS DISTINCT FROM OLD.text_resource_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.external_id IS DISTINCT FROM OLD.external_id
    OR NEW.has_audio IS DISTINCT FROM OLD.has_audio
  ) AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := next_catalogue_watermark();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Canonical links target invalidation; legacy reflection remains until rollback is retired.
CREATE OR REPLACE FUNCTION bump_linked_bibles_on_provider_resource_license()
RETURNS trigger AS $$
DECLARE
  only_audio_changed boolean;
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
    only_audio_changed := TG_OP = 'UPDATE'
      AND NEW.has_audio IS DISTINCT FROM OLD.has_audio
      AND NEW.tts_license_status IS NOT DISTINCT FROM OLD.tts_license_status
      AND NEW.recording_license_notice IS NOT DISTINCT FROM OLD.recording_license_notice
      AND NEW.text_license_notice IS NOT DISTINCT FROM OLD.text_license_notice
      AND NEW.display_name IS NOT DISTINCT FROM OLD.display_name
      AND NEW.provider IS NOT DISTINCT FROM OLD.provider
      AND NEW.external_id IS NOT DISTINCT FROM OLD.external_id;

    UPDATE bibles b SET
      provider = CASE WHEN b.text_resource_id IS NOT DISTINCT FROM NEW.id THEN NEW.provider::text::bible_provider ELSE b.provider END,
      external_id = CASE WHEN b.text_resource_id IS NOT DISTINCT FROM NEW.id THEN NEW.external_id ELSE b.external_id END,
      has_audio = CASE WHEN b.text_resource_id IS NOT DISTINCT FROM NEW.id THEN NEW.has_audio ELSE b.has_audio END,
      updated_at = next_catalogue_watermark()
    WHERE (
      b.text_resource_id IS NOT DISTINCT FROM NEW.id OR b.audio_resource_id = NEW.id
    ) AND NOT (
      -- A legacy Bible audio write already advanced this Bible before forwarding
      -- the same value. Do not republish it; other selected-recording links still bump.
      only_audio_changed AND b.text_resource_id IS NOT DISTINCT FROM NEW.id
      AND b.has_audio IS NOT DISTINCT FROM NEW.has_audio
      AND b.provider::text = NEW.provider::text AND b.external_id = NEW.external_id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

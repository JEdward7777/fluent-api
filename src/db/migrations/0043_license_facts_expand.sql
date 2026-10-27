CREATE TABLE "license_classifications" (
	"normalized_text" text PRIMARY KEY NOT NULL,
	"status" "tts_license_status" NOT NULL,
	"rationale" jsonb,
	"classified_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "bible_provider_resources" ADD COLUMN "recording_license_notice" text;--> statement-breakpoint
ALTER TABLE "bible_provider_resources" ADD COLUMN "text_license_notice" text;
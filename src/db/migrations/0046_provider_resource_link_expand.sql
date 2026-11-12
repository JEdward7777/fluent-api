ALTER TABLE "bible_provider_resources" ADD COLUMN "has_audio" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bibles" ADD COLUMN "text_resource_id" integer;--> statement-breakpoint
ALTER TABLE "bibles" ADD CONSTRAINT "bibles_text_resource_id_bible_provider_resources_id_fk" FOREIGN KEY ("text_resource_id") REFERENCES "public"."bible_provider_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_bibles_text_resource_id" ON "bibles" USING btree ("text_resource_id") WHERE "bibles"."text_resource_id" IS NOT NULL;
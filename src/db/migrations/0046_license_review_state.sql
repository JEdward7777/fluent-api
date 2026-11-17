CREATE TYPE "public"."license_review_state" AS ENUM('unreviewed', 'llm_reviewed', 'human_reviewed');--> statement-breakpoint
ALTER TABLE "license_classifications" ADD COLUMN "review_state" "license_review_state" DEFAULT 'unreviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE "license_classifications" ADD COLUMN "decision_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "license_classifications" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "license_classifications" ADD COLUMN "human_reviewed_at" timestamp with time zone;
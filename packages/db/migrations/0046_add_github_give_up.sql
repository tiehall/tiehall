ALTER TABLE "github_app" ADD COLUMN "mode_set_by" text DEFAULT 'tiehall' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_app" ADD COLUMN "webhook_given_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_redeliveries" ADD COLUMN "given_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_app" ADD CONSTRAINT "github_app_mode_set_by_known" CHECK ("github_app"."mode_set_by" IN ('admin', 'tiehall'));
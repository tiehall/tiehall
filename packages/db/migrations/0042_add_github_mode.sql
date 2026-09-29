ALTER TABLE "github_app" ADD COLUMN "mode" text DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_app" ADD COLUMN "mode_settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_app" ADD CONSTRAINT "github_app_mode_known" CHECK ("github_app"."mode" IN ('webhook', 'polling'));
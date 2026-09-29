ALTER TABLE "github_app" ADD COLUMN "polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_deliveries" ADD COLUMN "change_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "github_deliveries_change_key" ON "github_deliveries" USING btree ("org_id","change_key") WHERE "github_deliveries"."change_key" IS NOT NULL;
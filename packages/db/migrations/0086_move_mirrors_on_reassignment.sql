DROP INDEX "mirrors_request_place";--> statement-breakpoint
ALTER TABLE "mirrors" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "mirrors" ADD COLUMN "away" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mirrors_request_place_number" ON "mirrors" USING btree ("org_id","request_id","team_id","number","tracker","target");--> statement-breakpoint
ALTER TABLE "mirrors" ADD CONSTRAINT "mirrors_number_positive" CHECK ("mirrors"."number" IS NULL OR "mirrors"."number" > 0);
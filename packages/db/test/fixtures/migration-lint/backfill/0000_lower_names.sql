ALTER TABLE "things" ADD COLUMN "lower_name" text;
--> statement-breakpoint
UPDATE "things" SET "lower_name" = lower("name");

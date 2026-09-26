-- The expand step of 1.3.0 moved every reader to "title"; this drops what it replaced.
-- migrate: contract after 1.3.0
ALTER TABLE "things" DROP COLUMN "note";
--> statement-breakpoint
ALTER TABLE "things" ALTER COLUMN "name" SET NOT NULL;

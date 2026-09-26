CREATE TABLE "migration_log" (
	"step" integer NOT NULL
);
--> statement-breakpoint
-- Holds the migration lock long enough for a second runner to start and wait for it.
SELECT pg_sleep(0.5);

CREATE TABLE "things" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"drop_reason" text
);
--> statement-breakpoint
COMMENT ON COLUMN "things"."drop_reason" IS 'Why a job may UPDATE or DROP it; not a statement; DROP TABLE things;';

-- Neither this comment's DROP TABLE nor the one below is a statement.
/* ALTER TABLE "things" DROP COLUMN "name"; */
ALTER TABLE "things" ADD COLUMN "note" text;
--> statement-breakpoint
ALTER TABLE "things" ADD COLUMN "kind" text DEFAULT 'plain' NOT NULL;
--> statement-breakpoint
ALTER TABLE "things" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "things" ADD CONSTRAINT "things_name_unique" UNIQUE("name");
--> statement-breakpoint
ALTER TABLE "things" ALTER COLUMN "note" SET DEFAULT 'none';

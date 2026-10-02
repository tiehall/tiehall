CREATE TABLE "pull_request_mentions" (
	"org_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"number" integer NOT NULL,
	"keys" text[] NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pull_request_mentions_org_id_repository_id_number_pk" PRIMARY KEY("org_id","repository_id","number"),
	CONSTRAINT "pull_request_mentions_ids_positive" CHECK ("pull_request_mentions"."repository_id" > 0 AND "pull_request_mentions"."number" > 0),
	CONSTRAINT "pull_request_mentions_keys_bounded" CHECK (cardinality("pull_request_mentions"."keys") BETWEEN 1 AND 50)
);
--> statement-breakpoint
ALTER TABLE "pull_request_mentions" ADD CONSTRAINT "pull_request_mentions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;
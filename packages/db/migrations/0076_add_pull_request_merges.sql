CREATE TABLE "pull_request_merges" (
	"org_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"number" integer NOT NULL,
	"merged_at" timestamp with time zone NOT NULL,
	"close_on_merge_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pull_request_merges_org_id_repository_id_number_pk" PRIMARY KEY("org_id","repository_id","number"),
	CONSTRAINT "pull_request_merges_ids_positive" CHECK ("pull_request_merges"."repository_id" > 0 AND "pull_request_merges"."number" > 0)
);
--> statement-breakpoint
ALTER TABLE "pull_request_merges" ADD CONSTRAINT "pull_request_merges_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;
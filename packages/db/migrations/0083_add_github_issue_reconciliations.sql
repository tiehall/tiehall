CREATE TABLE "github_issue_reconciliations" (
	"org_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"reconciled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "github_issue_reconciliations_org_id_repository_id_pk" PRIMARY KEY("org_id","repository_id"),
	CONSTRAINT "github_issue_reconciliations_repository_id_positive" CHECK ("github_issue_reconciliations"."repository_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "github_issue_reconciliations" ADD CONSTRAINT "github_issue_reconciliations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;
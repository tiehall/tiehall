CREATE TABLE "sign_in_refusals" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"github_account_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"refused_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sign_in_refusals_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "sign_in_refusals_github_account_id_positive" CHECK ("sign_in_refusals"."github_account_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "sign_in_refusals" ADD CONSTRAINT "sign_in_refusals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;
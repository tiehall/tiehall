CREATE TABLE "applied_commitments" (
	"org_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"before" json NOT NULL,
	"created_revision" integer,
	"undone_at" timestamp with time zone,
	"undone_by_user_id" uuid,
	CONSTRAINT "applied_commitments_org_id_proposal_id_pk" PRIMARY KEY("org_id","proposal_id"),
	CONSTRAINT "applied_commitments_before_is_object" CHECK (json_typeof("applied_commitments"."before") = 'object'),
	CONSTRAINT "applied_commitments_undone_by_someone" CHECK (("applied_commitments"."undone_at" IS NULL) = ("applied_commitments"."undone_by_user_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "applied_commitments" ADD CONSTRAINT "applied_commitments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applied_commitments" ADD CONSTRAINT "applied_commitments_proposal_fk" FOREIGN KEY ("org_id","proposal_id") REFERENCES "public"."proposals"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applied_commitments" ADD CONSTRAINT "applied_commitments_undone_by_fk" FOREIGN KEY ("org_id","undone_by_user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;
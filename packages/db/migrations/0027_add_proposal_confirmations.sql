CREATE TABLE "proposal_confirmations" (
	"org_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"step" text NOT NULL,
	"user_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "proposal_confirmations_org_id_proposal_id_step_pk" PRIMARY KEY("org_id","proposal_id","step"),
	CONSTRAINT "proposal_confirmations_step_known" CHECK ("proposal_confirmations"."step" IN ('accountable_human', 'other_side'))
);
--> statement-breakpoint
ALTER TABLE "proposal_confirmations" ADD CONSTRAINT "proposal_confirmations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_confirmations" ADD CONSTRAINT "proposal_confirmations_proposal_fk" FOREIGN KEY ("org_id","proposal_id") REFERENCES "public"."proposals"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_confirmations" ADD CONSTRAINT "proposal_confirmations_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;
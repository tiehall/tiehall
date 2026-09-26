CREATE TABLE "sign_in_blocks" (
	"org_id" uuid NOT NULL,
	"github_account_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sign_in_blocks_org_id_github_account_id_pk" PRIMARY KEY("org_id","github_account_id")
);
--> statement-breakpoint
ALTER TABLE "sign_in_blocks" ADD CONSTRAINT "sign_in_blocks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_blocks" ADD CONSTRAINT "sign_in_blocks_user_fk" FOREIGN KEY ("org_id","github_account_id") REFERENCES "public"."users"("org_id","github_account_id") ON DELETE no action ON UPDATE no action;
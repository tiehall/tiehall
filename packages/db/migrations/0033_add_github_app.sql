CREATE TABLE "github_app" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"app_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"client_id" text NOT NULL,
	"owner_login" text NOT NULL,
	"owner_type" text NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_owner_type_known" CHECK ("github_app"."owner_type" IN ('Organization', 'User'))
);
--> statement-breakpoint
ALTER TABLE "github_app" ADD CONSTRAINT "github_app_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;
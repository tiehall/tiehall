CREATE TABLE "github_replaced_apps" (
	"org_id" uuid NOT NULL,
	"app_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"owner_login" text NOT NULL,
	"owner_type" text NOT NULL,
	"replaced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_replaced_apps_org_id_app_id_pk" PRIMARY KEY("org_id","app_id"),
	CONSTRAINT "github_replaced_apps_owner_type_known" CHECK ("github_replaced_apps"."owner_type" IN ('Organization', 'User'))
);
--> statement-breakpoint
ALTER TABLE "github_replaced_apps" ADD CONSTRAINT "github_replaced_apps_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;
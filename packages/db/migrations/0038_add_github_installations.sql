CREATE TABLE "github_connected_installations" (
	"org_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_connected_installations_org_id_installation_id_pk" PRIMARY KEY("org_id","installation_id")
);
--> statement-breakpoint
CREATE TABLE "github_covered_repositories" (
	"org_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_covered_repositories_org_id_installation_id_repository_id_pk" PRIMARY KEY("org_id","installation_id","repository_id"),
	CONSTRAINT "github_covered_repositories_repository_id_positive" CHECK ("github_covered_repositories"."repository_id" > 0)
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"app_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"repository_selection" text NOT NULL,
	"suspended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"first_listed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"listed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "github_installations_ids_positive" CHECK ("github_installations"."app_id" > 0 AND "github_installations"."installation_id" > 0 AND "github_installations"."account_id" > 0),
	CONSTRAINT "github_installations_account_type_known" CHECK ("github_installations"."account_type" IN ('Organization', 'User')),
	CONSTRAINT "github_installations_repository_selection_known" CHECK ("github_installations"."repository_selection" IN ('all', 'selected'))
);
--> statement-breakpoint
ALTER TABLE "github_connected_installations" ADD CONSTRAINT "github_connected_installations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_connected_installations" ADD CONSTRAINT "github_connected_installations_installation_fk" FOREIGN KEY ("org_id","installation_id") REFERENCES "public"."github_installations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_covered_repositories" ADD CONSTRAINT "github_covered_repositories_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_covered_repositories" ADD CONSTRAINT "github_covered_repositories_installation_fk" FOREIGN KEY ("org_id","installation_id") REFERENCES "public"."github_connected_installations"("org_id","installation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_covered_repositories_repository_id" ON "github_covered_repositories" USING btree ("org_id","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_installation_id" ON "github_installations" USING btree ("org_id","installation_id");
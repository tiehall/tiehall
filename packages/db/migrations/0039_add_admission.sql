CREATE TABLE "invites" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"github_account_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"role" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "invites_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "invites_github_account_id_positive" CHECK ("invites"."github_account_id" > 0),
	CONSTRAINT "invites_role_known" CHECK ("invites"."role" IN ('admin', 'member')),
	CONSTRAINT "invites_expire_after_creation" CHECK ("invites"."expires_at" > "invites"."created_at"),
	CONSTRAINT "invites_accepted_with_user" CHECK (("invites"."accepted_at" IS NULL) = ("invites"."accepted_by" IS NULL)),
	CONSTRAINT "invites_revoked_by_user" CHECK (("invites"."revoked_at" IS NULL) = ("invites"."revoked_by" IS NULL)),
	CONSTRAINT "invites_accepted_or_revoked" CHECK ("invites"."accepted_at" IS NULL OR "invites"."revoked_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "member_organizations" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"github_organization_id" bigint NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_organizations_org_id_user_id_github_organization_id_pk" PRIMARY KEY("org_id","user_id","github_organization_id"),
	CONSTRAINT "member_organizations_github_organization_id_positive" CHECK ("member_organizations"."github_organization_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_fk" FOREIGN KEY ("org_id","created_by") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_by_fk" FOREIGN KEY ("org_id","accepted_by") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_revoked_by_fk" FOREIGN KEY ("org_id","revoked_by") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_organizations" ADD CONSTRAINT "member_organizations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_organizations" ADD CONSTRAINT "member_organizations_member_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."members"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invites_github_account_id" ON "invites" USING btree ("org_id","github_account_id");
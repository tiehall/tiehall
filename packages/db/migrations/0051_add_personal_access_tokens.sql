CREATE TABLE "personal_access_tokens" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scopes" text[] NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "personal_access_tokens_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "personal_access_tokens_scopes_given" CHECK (cardinality("personal_access_tokens"."scopes") >= 1),
	CONSTRAINT "personal_access_tokens_expiry_after_creation" CHECK ("personal_access_tokens"."expires_at" > "personal_access_tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "install_settings" ADD COLUMN "personal_access_token_max_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "personal_access_tokens_token_hash" ON "personal_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "personal_access_tokens_user" ON "personal_access_tokens" USING btree ("org_id","user_id");--> statement-breakpoint
ALTER TABLE "install_settings" ADD CONSTRAINT "install_settings_personal_access_token_max_days_range" CHECK ("install_settings"."personal_access_token_max_days" BETWEEN 1 AND 90);
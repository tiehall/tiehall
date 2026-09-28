CREATE TABLE "sign_in_accounts" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sign_in_accounts_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "sign_in_accounts_github_only" CHECK ("sign_in_accounts"."provider_id" = 'github' AND "sign_in_accounts"."account_id" ~ '^[1-9][0-9]{0,18}$'),
	CONSTRAINT "sign_in_accounts_no_password" CHECK ("sign_in_accounts"."password" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "sign_in_verifications" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sign_in_verifications_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "web_sessions_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sign_in_key" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "sign_in_accounts" ADD CONSTRAINT "sign_in_accounts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_accounts" ADD CONSTRAINT "sign_in_accounts_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_verifications" ADD CONSTRAINT "sign_in_verifications_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sign_in_accounts_account" ON "sign_in_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sign_in_accounts_user_id" ON "sign_in_accounts" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "sign_in_verifications_identifier" ON "sign_in_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "web_sessions_token" ON "web_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "web_sessions_user_id" ON "web_sessions" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_sign_in_key" ON "users" USING btree ("sign_in_key");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_sign_in_key_format" CHECK ("users"."sign_in_key" IS NULL OR "users"."sign_in_key" = 'github:' || "users"."github_account_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_no_image" CHECK ("users"."image" IS NULL);
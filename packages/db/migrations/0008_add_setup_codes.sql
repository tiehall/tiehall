CREATE TABLE "setup_codes" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_codes_hash_length" CHECK (octet_length("setup_codes"."code_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "setup_sessions" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_sessions_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "setup_sessions_hash_length" CHECK (octet_length("setup_sessions"."token_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "orgs" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "setup_codes" ADD CONSTRAINT "setup_codes_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_sessions" ADD CONSTRAINT "setup_sessions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "setup_sessions_token_hash" ON "setup_sessions" USING btree ("org_id","token_hash");
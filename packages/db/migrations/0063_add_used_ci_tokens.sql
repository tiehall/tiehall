CREATE TABLE "used_ci_tokens" (
	"org_id" uuid NOT NULL,
	"jti_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "used_ci_tokens_org_id_jti_hash_pk" PRIMARY KEY("org_id","jti_hash"),
	CONSTRAINT "used_ci_tokens_hash_length" CHECK (octet_length("used_ci_tokens"."jti_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "used_ci_tokens" ADD CONSTRAINT "used_ci_tokens_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "used_ci_tokens_expires_at" ON "used_ci_tokens" USING btree ("org_id","expires_at");
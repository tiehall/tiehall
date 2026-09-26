CREATE TABLE "used_confirmation_nonces" (
	"org_id" uuid NOT NULL,
	"nonce_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "used_confirmation_nonces_org_id_nonce_hash_pk" PRIMARY KEY("org_id","nonce_hash"),
	CONSTRAINT "used_confirmation_nonces_hash_length" CHECK (octet_length("used_confirmation_nonces"."nonce_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "used_confirmation_nonces" ADD CONSTRAINT "used_confirmation_nonces_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "used_confirmation_nonces_expires_at" ON "used_confirmation_nonces" USING btree ("org_id","expires_at");
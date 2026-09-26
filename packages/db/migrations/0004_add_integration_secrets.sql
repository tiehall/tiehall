CREATE TABLE "integration_secrets" (
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_id" text NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_secrets_org_id_name_pk" PRIMARY KEY("org_id","name"),
	CONSTRAINT "integration_secrets_key_id_format" CHECK ("integration_secrets"."key_id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "integration_secrets_nonce_length" CHECK (octet_length("integration_secrets"."nonce") = 12)
);
--> statement-breakpoint
ALTER TABLE "integration_secrets" ADD CONSTRAINT "integration_secrets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;
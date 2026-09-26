CREATE TABLE "idempotency_keys" (
	"org_id" uuid NOT NULL,
	"caller" text NOT NULL,
	"key" text NOT NULL,
	"request_digest" "bytea" NOT NULL,
	"status" integer,
	"body" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_org_id_caller_key_pk" PRIMARY KEY("org_id","caller","key"),
	CONSTRAINT "idempotency_keys_digest_length" CHECK (octet_length("idempotency_keys"."request_digest") = 32)
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_at" ON "idempotency_keys" USING btree ("org_id","created_at");
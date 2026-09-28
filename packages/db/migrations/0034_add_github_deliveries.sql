CREATE TABLE "github_deliveries" (
	"org_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enqueued_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	CONSTRAINT "github_deliveries_org_id_delivery_id_pk" PRIMARY KEY("org_id","delivery_id"),
	CONSTRAINT "github_deliveries_delivery_id_format" CHECK ("github_deliveries"."delivery_id" ~ '^[A-Za-z0-9-]{1,100}$'),
	CONSTRAINT "github_deliveries_event_format" CHECK ("github_deliveries"."event" ~ '^[a-z_]{1,100}$'),
	CONSTRAINT "github_deliveries_payload_is_object" CHECK (jsonb_typeof("github_deliveries"."payload") = 'object')
);
--> statement-breakpoint
ALTER TABLE "github_deliveries" ADD CONSTRAINT "github_deliveries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_deliveries_held" ON "github_deliveries" USING btree ("org_id") WHERE "github_deliveries"."enqueued_at" IS NULL;
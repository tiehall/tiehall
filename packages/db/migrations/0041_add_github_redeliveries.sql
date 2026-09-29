CREATE TABLE "github_redeliveries" (
	"org_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"asks" integer DEFAULT 1 NOT NULL,
	"last_asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_redeliveries_org_id_delivery_id_pk" PRIMARY KEY("org_id","delivery_id"),
	CONSTRAINT "github_redeliveries_delivery_id_format" CHECK ("github_redeliveries"."delivery_id" ~ '^[A-Za-z0-9-]{1,100}$'),
	CONSTRAINT "github_redeliveries_asks_positive" CHECK ("github_redeliveries"."asks" > 0)
);
--> statement-breakpoint
ALTER TABLE "github_app" ADD COLUMN "redelivery_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_redeliveries" ADD CONSTRAINT "github_redeliveries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;
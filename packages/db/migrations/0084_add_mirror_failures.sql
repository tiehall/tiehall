CREATE TABLE "mirror_failures" (
	"org_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"failed_at" timestamp with time zone NOT NULL,
	"retried_at" timestamp with time zone,
	CONSTRAINT "mirror_failures_org_id_request_id_pk" PRIMARY KEY("org_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "mirror_failures" ADD CONSTRAINT "mirror_failures_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_failures" ADD CONSTRAINT "mirror_failures_request_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."requests"("org_id","id") ON DELETE no action ON UPDATE no action;
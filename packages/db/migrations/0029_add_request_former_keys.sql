CREATE TABLE "request_former_keys" (
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"request_id" uuid NOT NULL,
	CONSTRAINT "request_former_keys_org_id_team_id_number_pk" PRIMARY KEY("org_id","team_id","number"),
	CONSTRAINT "request_former_keys_number_positive" CHECK ("request_former_keys"."number" > 0)
);
--> statement-breakpoint
ALTER TABLE "request_former_keys" ADD CONSTRAINT "request_former_keys_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_former_keys" ADD CONSTRAINT "request_former_keys_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_former_keys" ADD CONSTRAINT "request_former_keys_request_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."requests"("org_id","id") ON DELETE no action ON UPDATE no action;
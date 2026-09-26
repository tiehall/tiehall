-- Every table carries org_id in its key and in each foreign key.
CREATE TABLE "squads" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "squads_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "squads_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs" ("id")
);
CREATE TABLE "squad_members" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" uuid NOT NULL,
	CONSTRAINT "squad_members_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "squad_members_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs" ("id"),
	CONSTRAINT "squad_members_org_id_squad_id_squads_org_id_id_fk" FOREIGN KEY ("org_id", "squad_id") REFERENCES "squads" ("org_id", "id")
);
-- One row per org, keyed by org_id alone.
CREATE TABLE "counters" (
	"org_id" uuid PRIMARY KEY NOT NULL REFERENCES "orgs" ("id"),
	"value" bigint NOT NULL
);

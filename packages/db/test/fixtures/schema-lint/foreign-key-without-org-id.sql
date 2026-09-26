-- "squads" is keyed right; "squad_members" points at a squad by its id alone, so a member could name another org's squad.
CREATE TABLE "squads" (
	"org_id" uuid NOT NULL REFERENCES "orgs" ("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "squads_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "squads_id_unique" UNIQUE ("id")
);
CREATE TABLE "squad_members" (
	"org_id" uuid NOT NULL REFERENCES "orgs" ("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" uuid NOT NULL,
	CONSTRAINT "squad_members_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "squad_members_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "squads" ("id")
);

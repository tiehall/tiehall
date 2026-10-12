-- Each mirror keeps the mapping that made it (decisions-from-groups-15-28, design.md, Decisions this change rests on:
-- D55 (75)). A mapping gets an id of its own, which the column's default gives every mapping made from now on and
-- none made before; a mirror names its mapping's id, and one made before names none. A request may have a mirror
-- under each mapping its team has had in one place, so the mapping joins the mirror's unique key. Each step only adds,
-- or relaxes a unique key, so the previous image still runs.
ALTER TABLE "tracker_mappings" ADD COLUMN "id" uuid;--> statement-breakpoint
ALTER TABLE "tracker_mappings" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "mirrors" ADD COLUMN "mapping_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "mirrors_request_mapping_number" ON "mirrors" USING btree ("org_id","request_id","team_id","number","tracker","target","mapping_id");--> statement-breakpoint
DROP INDEX "mirrors_request_place_number";

-- migrate: no-transaction
-- A request's latest domain events and the domain events within a time, for the request page's activity and the live
-- hall (web-ui-design, design.md, Design: The request page's activity). Built concurrently, so writes go on meanwhile;
-- both only add, so the previous image still starts.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_request_number" ON "events" USING btree ("org_id",("data" ->> 'requestId'),"number" DESC NULLS FIRST) WHERE class = 'domain';--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_domain_occurred_at" ON "events" USING btree ("org_id","occurred_at") WHERE class = 'domain';

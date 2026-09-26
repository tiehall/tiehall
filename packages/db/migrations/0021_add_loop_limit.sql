ALTER TABLE "requests" ADD COLUMN "needs_human" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "agent_write_times" timestamp with time zone[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_agent_write_times_bounded" CHECK (cardinality("requests"."agent_write_times") <= 30);
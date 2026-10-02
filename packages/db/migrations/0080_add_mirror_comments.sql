ALTER TABLE "mirrors" ADD COLUMN "commented_through" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mirrors" ADD COLUMN "shown_state" text;--> statement-breakpoint
ALTER TABLE "mirrors" ADD COLUMN "pending_comment" jsonb;--> statement-breakpoint
ALTER TABLE "mirrors" ADD CONSTRAINT "mirrors_commented_through_not_negative" CHECK ("mirrors"."commented_through" >= 0);--> statement-breakpoint
ALTER TABLE "mirrors" ADD CONSTRAINT "mirrors_shown_state_known" CHECK ("mirrors"."shown_state" IS NULL OR "mirrors"."shown_state" IN ('open', 'claimed', 'in_progress', 'needs_info', 'done', 'declined', 'withdrawn'));--> statement-breakpoint
ALTER TABLE "mirrors" ADD CONSTRAINT "mirrors_pending_comment_is_object" CHECK ("mirrors"."pending_comment" IS NULL OR jsonb_typeof("mirrors"."pending_comment") = 'object');
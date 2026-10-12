ALTER TABLE "receipts" DROP CONSTRAINT "receipts_kind_known";--> statement-breakpoint
ALTER TABLE "receipts" ALTER COLUMN "proposal_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "action" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "review" jsonb;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_subject_known" CHECK (CASE WHEN "receipts"."kind" = 'confirmed' THEN "receipts"."proposal_id" IS NULL AND "receipts"."action" IS NOT NULL AND "receipts"."review" IS NOT NULL ELSE "receipts"."proposal_id" IS NOT NULL AND "receipts"."action" IS NULL AND "receipts"."review" IS NULL END);--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_kind_known" CHECK ("receipts"."kind" IN ('waits_for_other_side', 'took_effect', 'undone', 'confirmed'));
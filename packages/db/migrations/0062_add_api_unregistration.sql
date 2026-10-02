ALTER TABLE "apis" ADD COLUMN "unregistered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN "unregistered_by" uuid;--> statement-breakpoint
ALTER TABLE "apis" ADD CONSTRAINT "apis_unregistered_by_fk" FOREIGN KEY ("org_id","unregistered_by") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apis" ADD CONSTRAINT "apis_unregistered_by_someone" CHECK (("apis"."unregistered_at" IS NULL) = ("apis"."unregistered_by" IS NULL));
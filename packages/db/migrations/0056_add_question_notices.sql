CREATE TABLE "question_notices" (
	"org_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "question_notices_org_id_message_id_user_id_pk" PRIMARY KEY("org_id","message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "question_notices" ADD CONSTRAINT "question_notices_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_notices" ADD CONSTRAINT "question_notices_message_fk" FOREIGN KEY ("org_id","message_id") REFERENCES "public"."messages"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_notices" ADD CONSTRAINT "question_notices_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;
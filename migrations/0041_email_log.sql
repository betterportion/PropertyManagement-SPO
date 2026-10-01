CREATE TABLE "email_log" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template" varchar NOT NULL,
	"recipient" varchar NOT NULL,
	"outcome" varchar NOT NULL,
	"error_class" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "IDX_email_log_created_at" ON "email_log" USING btree ("created_at");
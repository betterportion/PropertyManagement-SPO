CREATE TABLE "feedback_reports" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar NOT NULL,
	"message" text NOT NULL,
	"page_path" varchar,
	"role" varchar NOT NULL,
	"regions" varchar,
	"house_address" varchar,
	"submitted_by_id" varchar,
	"submitted_by_email" varchar,
	"submitted_by_name" varchar,
	"screenshot_url" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "IDX_feedback_reports_created_at" ON "feedback_reports" USING btree ("created_at");
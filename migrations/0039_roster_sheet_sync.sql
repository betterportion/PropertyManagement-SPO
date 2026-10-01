CREATE TABLE "resident_sheet_links" (
	"resident_id" varchar PRIMARY KEY NOT NULL,
	"synced_values" jsonb NOT NULL,
	"synced_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_review_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" varchar NOT NULL,
	"kind" varchar NOT NULL,
	"resident_id" varchar,
	"email" varchar,
	"name" varchar,
	"field" varchar,
	"old_value" text,
	"new_value" text,
	"edited_by_email" varchar,
	"edited_at" timestamp,
	"detail" text NOT NULL,
	"status" varchar DEFAULT 'open' NOT NULL,
	"reviewed_by_email" varchar,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_sync_runs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" varchar NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"ok" boolean NOT NULL,
	"rows_read" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"conflicts" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"skipped_rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refused_columns" text[] DEFAULT '{}' NOT NULL,
	"error" text,
	"actor_email" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "residents" ADD COLUMN "payment_plan" varchar;--> statement-breakpoint
ALTER TABLE "residents" ADD COLUMN "edited_at" timestamp;--> statement-breakpoint
ALTER TABLE "residents" ADD COLUMN "edited_by_email" varchar;--> statement-breakpoint
ALTER TABLE "resident_sheet_links" ADD CONSTRAINT "resident_sheet_links_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_review_items" ADD CONSTRAINT "roster_review_items_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "IDX_roster_review_open_dedupe" ON "roster_review_items" USING btree ("dedupe_key") WHERE status = 'open';
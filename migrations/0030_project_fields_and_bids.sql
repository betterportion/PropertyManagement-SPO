CREATE TABLE "maintenance_request_bids" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" varchar NOT NULL,
	"contact_id" varchar,
	"vendor_name" varchar,
	"amount" numeric(12, 2) NOT NULL,
	"bid_date" timestamp,
	"notes" text,
	"document_url" varchar,
	"document_name" varchar,
	"accepted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "maintenance_requests" ADD COLUMN "contract_url" varchar;--> statement-breakpoint
ALTER TABLE "maintenance_requests" ADD COLUMN "estimated_cost" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "maintenance_requests" ADD COLUMN "actual_cost" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "maintenance_requests" ADD COLUMN "target_year" integer;--> statement-breakpoint
ALTER TABLE "maintenance_requests" ADD COLUMN "target_quarter" integer;--> statement-breakpoint
ALTER TABLE "maintenance_request_bids" ADD CONSTRAINT "maintenance_request_bids_request_id_maintenance_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_request_bids" ADD CONSTRAINT "maintenance_request_bids_contact_id_maintenance_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."maintenance_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_request_bids_request_idx" ON "maintenance_request_bids" USING btree ("request_id");
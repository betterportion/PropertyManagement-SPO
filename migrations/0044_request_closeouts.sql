CREATE TABLE "request_closeout_contacts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"closeout_id" varchar NOT NULL,
	"contact_id" varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_closeouts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" varchar NOT NULL,
	"first_visit" boolean,
	"quote_matched" boolean,
	"callback" boolean,
	"would_use_again" boolean,
	"note" text,
	"completed_at" timestamp DEFAULT now() NOT NULL,
	"completed_by_email" varchar,
	"completed_by_name" varchar,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "request_closeouts_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
ALTER TABLE "request_closeout_contacts" ADD CONSTRAINT "request_closeout_contacts_closeout_id_request_closeouts_id_fk" FOREIGN KEY ("closeout_id") REFERENCES "public"."request_closeouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_closeout_contacts" ADD CONSTRAINT "request_closeout_contacts_contact_id_maintenance_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."maintenance_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_closeouts" ADD CONSTRAINT "request_closeouts_request_id_maintenance_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "IDX_request_closeout_contact" ON "request_closeout_contacts" USING btree ("closeout_id","contact_id");--> statement-breakpoint
CREATE INDEX "IDX_request_closeout_contacts_contact" ON "request_closeout_contacts" USING btree ("contact_id");
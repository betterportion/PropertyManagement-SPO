CREATE TABLE "maintenance_request_comments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" varchar NOT NULL,
	"body" text NOT NULL,
	"is_internal" boolean DEFAULT true NOT NULL,
	"author_user_id" varchar,
	"author_email" varchar,
	"author_name" varchar,
	"relay_source" varchar,
	"relay_contact_id" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "maintenance_request_comments" ADD CONSTRAINT "maintenance_request_comments_request_id_maintenance_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_request_comments" ADD CONSTRAINT "maintenance_request_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_request_comments" ADD CONSTRAINT "maintenance_request_comments_relay_contact_id_maintenance_contacts_id_fk" FOREIGN KEY ("relay_contact_id") REFERENCES "public"."maintenance_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_request_comments_request_idx" ON "maintenance_request_comments" USING btree ("request_id");
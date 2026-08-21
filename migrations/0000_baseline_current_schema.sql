CREATE TABLE "asset_photos" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" varchar NOT NULL,
	"image_url" varchar NOT NULL,
	"caption" text,
	"uploaded_by" varchar NOT NULL,
	"uploaded_date" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar NOT NULL,
	"category" varchar NOT NULL,
	"type" varchar NOT NULL,
	"age_in_years" integer NOT NULL,
	"last_serviced" timestamp,
	"serial_number" varchar,
	"purchase_price" numeric(12, 2),
	"asset_tag_id" varchar,
	"property_id" varchar,
	"location" varchar NOT NULL,
	"region" varchar NOT NULL,
	"building_address" varchar NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "billing_records" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" varchar,
	"company_name" varchar NOT NULL,
	"email" varchar NOT NULL,
	"phone" varchar NOT NULL,
	"invoice_cost" numeric(12, 2) NOT NULL,
	"contract_invoice_url" varchar,
	"coi_url" varchar,
	"w9_url" varchar,
	"region" varchar DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" varchar NOT NULL,
	"contact_id" varchar,
	"maintenance_request_id" varchar,
	"service" varchar NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"due_date" timestamp NOT NULL,
	"paid_date" timestamp,
	"region" varchar NOT NULL,
	"building_address" varchar NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "maintenance_contacts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar NOT NULL,
	"company" varchar NOT NULL,
	"service" varchar NOT NULL,
	"phone" varchar NOT NULL,
	"email" varchar NOT NULL,
	"region" varchar NOT NULL,
	"building_address" varchar NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "maintenance_requests" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar NOT NULL,
	"description" text NOT NULL,
	"category" varchar NOT NULL,
	"priority" varchar NOT NULL,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"location" varchar NOT NULL,
	"region" varchar NOT NULL,
	"building_address" varchar NOT NULL,
	"submitted_by" varchar NOT NULL,
	"submitted_date" timestamp DEFAULT now(),
	"completed_date" timestamp,
	"monday_item_id" varchar,
	"photo_url" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar NOT NULL,
	"street_address" varchar NOT NULL,
	"city" varchar NOT NULL,
	"state" varchar NOT NULL,
	"zip_code" varchar NOT NULL,
	"address" varchar NOT NULL,
	"region" varchar NOT NULL,
	"property_manager" varchar,
	"bedrooms" integer,
	"bathrooms" numeric(3, 1),
	"square_footage" integer,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "properties_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "request_contacts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" varchar NOT NULL,
	"contact_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_permissions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"can_view_maintenance" boolean DEFAULT true NOT NULL,
	"can_manage_maintenance" boolean DEFAULT false NOT NULL,
	"can_view_walkthroughs" boolean DEFAULT false NOT NULL,
	"can_manage_walkthroughs" boolean DEFAULT false NOT NULL,
	"can_view_assets" boolean DEFAULT false NOT NULL,
	"can_manage_assets" boolean DEFAULT false NOT NULL,
	"can_view_billing" boolean DEFAULT false NOT NULL,
	"can_manage_billing" boolean DEFAULT false NOT NULL,
	"can_view_contacts" boolean DEFAULT false NOT NULL,
	"can_manage_contacts" boolean DEFAULT false NOT NULL,
	"can_manage_users" boolean DEFAULT false NOT NULL,
	"can_view_properties" boolean DEFAULT false NOT NULL,
	"can_manage_properties" boolean DEFAULT false NOT NULL,
	"allowed_regions" text[] DEFAULT '{}',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "user_permissions_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"profile_image_url" varchar,
	"role" varchar DEFAULT 'resident' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "walkthrough_photos" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" varchar NOT NULL,
	"image_url" varchar NOT NULL,
	"condition" varchar NOT NULL,
	"notes" text,
	"region" varchar NOT NULL,
	"building_address" varchar NOT NULL,
	"location" varchar NOT NULL,
	"question_answers" jsonb,
	"uploaded_by" varchar NOT NULL,
	"uploaded_date" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "walkthrough_rooms" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar NOT NULL,
	"property_id" varchar,
	"building_address" varchar NOT NULL,
	"required_questions" text[],
	"display_order" integer NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "asset_photos" ADD CONSTRAINT "asset_photos_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contact_id_maintenance_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."maintenance_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_maintenance_request_id_maintenance_requests_id_fk" FOREIGN KEY ("maintenance_request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_contacts" ADD CONSTRAINT "request_contacts_request_id_maintenance_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_contacts" ADD CONSTRAINT "request_contacts_contact_id_maintenance_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."maintenance_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walkthrough_photos" ADD CONSTRAINT "walkthrough_photos_room_id_walkthrough_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."walkthrough_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");
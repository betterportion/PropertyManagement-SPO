CREATE TABLE "property_quickbooks_links" (
	"property_id" varchar PRIMARY KEY NOT NULL,
	"kind" varchar DEFAULT 'class' NOT NULL,
	"external_id" varchar NOT NULL,
	"external_name" varchar NOT NULL,
	"region" varchar NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "property_spend" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" varchar NOT NULL,
	"fiscal_year" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"region" varchar NOT NULL,
	"synced_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quickbooks_integration" (
	"id" varchar PRIMARY KEY DEFAULT 'default' NOT NULL,
	"realm_id" varchar,
	"company_name" varchar,
	"encrypted_refresh_token" text,
	"refresh_token_expires_at" timestamp,
	"connected_at" timestamp,
	"connected_by_email" varchar,
	"repair_account_ids" text[] DEFAULT '{}' NOT NULL,
	"last_attempt_at" timestamp,
	"last_success_at" timestamp,
	"last_error" text,
	"last_error_at" timestamp,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "property_quickbooks_links" ADD CONSTRAINT "property_quickbooks_links_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_spend" ADD CONSTRAINT "property_spend_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "IDX_property_spend_fiscal_year" ON "property_spend" USING btree ("property_id","fiscal_year");
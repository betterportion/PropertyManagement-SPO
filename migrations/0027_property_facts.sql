CREATE TABLE "property_facts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" varchar NOT NULL,
	"door_code" varchar,
	"door_code_updated_at" timestamp,
	"gate_code" varchar,
	"gate_code_updated_at" timestamp,
	"alarm_code" varchar,
	"alarm_code_updated_at" timestamp,
	"security_notes" text,
	"parking_rules" text,
	"surface_care" text,
	"do_nots" text,
	"rubbish_day" varchar,
	"other_notes" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "property_facts_property_id_unique" UNIQUE("property_id")
);
--> statement-breakpoint
ALTER TABLE "property_facts" ADD CONSTRAINT "property_facts_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
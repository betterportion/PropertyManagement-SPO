CREATE TABLE "deposit_return_rules" (
	"state" varchar(2) PRIMARY KEY NOT NULL,
	"days" integer NOT NULL,
	"updated_by_email" varchar,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "move_out_checklists" (
	"resident_id" varchar PRIMARY KEY NOT NULL,
	"region" varchar NOT NULL,
	"room_inspected" boolean DEFAULT false NOT NULL,
	"damage_notes" text,
	"belongings_removed" boolean DEFAULT false NOT NULL,
	"keys_returned" boolean DEFAULT false NOT NULL,
	"notes" text,
	"completed_at" timestamp,
	"completed_by_email" varchar,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "move_out_photos" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resident_id" varchar NOT NULL,
	"image_url" varchar NOT NULL,
	"region" varchar NOT NULL,
	"uploaded_by_email" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "move_out_checklists" ADD CONSTRAINT "move_out_checklists_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_out_photos" ADD CONSTRAINT "move_out_photos_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE cascade ON UPDATE no action;
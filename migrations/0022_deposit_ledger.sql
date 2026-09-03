CREATE TABLE "deposit_deductions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resident_id" varchar NOT NULL,
	"property_id" varchar NOT NULL,
	"description" varchar NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"charge_date" timestamp NOT NULL,
	"recorded_by_user_id" varchar,
	"recorded_by_email" varchar,
	"walkthrough_item_id" varchar,
	"maintenance_request_id" varchar,
	"split_group_id" varchar,
	"region" varchar NOT NULL,
	"building_address" varchar NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "deposit_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "deposit_return_days" integer;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "deposit_notes" text;--> statement-breakpoint
ALTER TABLE "residents" ADD COLUMN "deposit_amount_override" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "security_deposits" ADD COLUMN "statement_provided_on" timestamp;--> statement-breakpoint
ALTER TABLE "security_deposits" ADD COLUMN "closeout_reference" varchar;--> statement-breakpoint
ALTER TABLE "deposit_deductions" ADD CONSTRAINT "deposit_deductions_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_deductions" ADD CONSTRAINT "deposit_deductions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
CREATE TABLE "rent_payments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resident_id" varchar NOT NULL,
	"property_id" varchar NOT NULL,
	"period" varchar NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"status" varchar DEFAULT 'unpaid' NOT NULL,
	"paid_date" timestamp,
	"reference" varchar,
	"notes" text,
	"region" varchar NOT NULL,
	"building_address" varchar NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "security_deposits" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resident_id" varchar NOT NULL,
	"property_id" varchar NOT NULL,
	"amount_held" numeric(12, 2) NOT NULL,
	"status" varchar DEFAULT 'held' NOT NULL,
	"amount_returned" numeric(12, 2),
	"returned_date" timestamp,
	"deductions_notes" text,
	"region" varchar NOT NULL,
	"building_address" varchar NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "rent_payments" ADD CONSTRAINT "rent_payments_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_deposits" ADD CONSTRAINT "security_deposits_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "IDX_rent_payment_resident_period" ON "rent_payments" USING btree ("resident_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "IDX_security_deposit_resident" ON "security_deposits" USING btree ("resident_id");
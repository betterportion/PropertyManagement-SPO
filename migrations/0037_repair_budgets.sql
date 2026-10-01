CREATE TABLE "repair_budgets" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" varchar NOT NULL,
	"fiscal_year" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"region" varchar NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "repair_budgets" ADD CONSTRAINT "repair_budgets_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "IDX_repair_budget_fiscal_year" ON "repair_budgets" USING btree ("property_id","fiscal_year");
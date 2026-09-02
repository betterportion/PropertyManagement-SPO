CREATE TABLE "walkthrough_template_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_room_id" varchar NOT NULL,
	"label" varchar NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "walkthrough_template_rooms" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar NOT NULL,
	"include_by_default" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "walkthrough_template_items" ADD CONSTRAINT "walkthrough_template_items_template_room_id_walkthrough_template_rooms_id_fk" FOREIGN KEY ("template_room_id") REFERENCES "public"."walkthrough_template_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ===========================================================================
-- A starting template, so the feature works the day it ships.
--
-- PROVISIONAL. SPO's own walkthrough forms are still outstanding (open item 7
-- in the plan), and this is a reasonable guess at a student house, not a copy
-- of how the work is really done. It is seeded as ordinary rows precisely so
-- replacing it is a data change an admin makes in the app -- not a migration.
--
-- Idempotent: only seeds an empty template, so re-running never duplicates a
-- room and never overwrites edits somebody has already made.
-- ===========================================================================
DO $$
DECLARE
  room_id     varchar;
  room_name   text;
  room_order  integer := 0;
  is_standard boolean;
  item_label  text;
  item_order  integer;
  spec        record;
BEGIN
  IF EXISTS (SELECT 1 FROM walkthrough_template_rooms) THEN
    RAISE NOTICE 'walkthrough template already populated; leaving it alone';
    RETURN;
  END IF;

  FOR spec IN
    SELECT * FROM (VALUES
      ('Kitchen',      true,  ARRAY['Refrigerator','Range and oven','Dishwasher','Sink and taps','Under-sink plumbing','Cabinets and worktops','Floor','Walls and ceiling','Lighting','Windows']),
      ('Living Room',  true,  ARRAY['Floor','Walls and ceiling','Windows','Lighting','Heating','Furniture provided','Smoke detector']),
      ('Bathroom',     true,  ARRAY['Toilet','Sink and taps','Bath or shower','Extractor fan','Floor','Walls and ceiling','Mirror and fittings','Lighting']),
      ('Bedroom',      true,  ARRAY['Floor','Walls and ceiling','Window','Lighting','Heating','Door and lock','Furniture provided','Smoke detector']),
      ('Hallway',      true,  ARRAY['Floor','Walls and ceiling','Lighting','Smoke detector','Front door and lock']),
      ('Laundry',      true,  ARRAY['Washer','Dryer','Sink','Floor','Ventilation']),
      ('Basement',     true,  ARRAY['Furnace','Water heater','Signs of moisture','Floor','Walls','Lighting','Carbon monoxide detector']),
      ('Exterior',     true,  ARRAY['Roof and gutters','Siding','Windows from outside','Steps and railings','Walkways','Yard and landscaping','Rubbish and recycling']),
      -- Known room types that most houses do not have. Not seeded into a new
      -- walkthrough; added by hand, which prefills these items.
      ('Garage',       false, ARRAY['Door and opener','Floor','Lighting','Storage']),
      ('Porch',        false, ARRAY['Decking or floor','Railings','Steps','Lighting']),
      ('Dining Room',  false, ARRAY['Floor','Walls and ceiling','Window','Lighting','Furniture provided'])
    ) AS t(name, standard, items)
  LOOP
    room_name   := spec.name;
    is_standard := spec.standard;

    INSERT INTO walkthrough_template_rooms (name, include_by_default, display_order)
    VALUES (room_name, is_standard, room_order)
    RETURNING id INTO room_id;

    item_order := 0;
    FOREACH item_label IN ARRAY spec.items LOOP
      INSERT INTO walkthrough_template_items (template_room_id, label, display_order)
      VALUES (room_id, item_label, item_order);
      item_order := item_order + 1;
    END LOOP;

    room_order := room_order + 1;
  END LOOP;

  RAISE NOTICE 'walkthrough template seeded: % rooms, % items',
    (SELECT count(*) FROM walkthrough_template_rooms),
    (SELECT count(*) FROM walkthrough_template_items);
END $$;

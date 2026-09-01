CREATE TABLE "walkthrough_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" varchar NOT NULL,
	"label" varchar NOT NULL,
	"condition" varchar DEFAULT 'not_recorded' NOT NULL,
	"notes" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "walkthroughs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" varchar NOT NULL,
	"walkthrough_date" timestamp DEFAULT now() NOT NULL,
	"type" varchar DEFAULT 'annual' NOT NULL,
	"status" varchar DEFAULT 'draft' NOT NULL,
	"performed_by" varchar,
	"notes" text,
	"region" varchar NOT NULL,
	"building_address" varchar NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "walkthrough_photos" ALTER COLUMN "condition" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "walkthrough_rooms" ADD COLUMN "walkthrough_id" varchar;--> statement-breakpoint
ALTER TABLE "walkthrough_items" ADD CONSTRAINT "walkthrough_items_room_id_walkthrough_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."walkthrough_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walkthroughs" ADD CONSTRAINT "walkthroughs_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walkthrough_rooms" ADD CONSTRAINT "walkthrough_rooms_walkthrough_id_walkthroughs_id_fk" FOREIGN KEY ("walkthrough_id") REFERENCES "public"."walkthroughs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ===========================================================================
-- Backfill: every existing room moves into one legacy walkthrough per house.
--
-- The rules this has to honour, from the plan:
--   * no existing photo or note may be lost;
--   * counts are verified inside the migration, not afterwards by hand.
--
-- Three things are deliberately NOT done:
--   * walkthrough_photos.condition is not reinterpreted. That vocabulary
--     records CHANGE since the last visit ("same as last walkthrough"), not
--     STATE, so mapping it onto a condition scale would invent an assessment
--     nobody made. Only `additional_damage` -- which really is a claim about
--     state -- becomes an item.
--   * requiredQuestions is not dropped. Each entry becomes an item AND the
--     array stays, so this migration can be checked by inspection afterwards.
--   * performed_by is left null. Nobody recorded who did these, and a guess
--     in an audit-relevant field is worse than an honest blank.
-- ===========================================================================
DO $$
DECLARE
  rooms_before   integer;
  photos_before  integer;
  questions_before integer;
  rooms_after    integer;
  photos_after   integer;
  items_from_q   integer;
  unassigned     integer;
  unresolvable   integer;
BEGIN
  SELECT count(*) INTO rooms_before  FROM walkthrough_rooms;
  SELECT count(*) INTO photos_before FROM walkthrough_photos;
  SELECT coalesce(sum(coalesce(array_length(required_questions, 1), 0)), 0)
    INTO questions_before FROM walkthrough_rooms;

  -- 1. Resolve each room to a property: the FK first, then the denormalised
  --    address, which is how rooms were linked before property_id existed.
  CREATE TEMP TABLE _room_property ON COMMIT DROP AS
  SELECT r.id AS room_id,
         coalesce(p_by_id.id, p_by_addr.id) AS property_id
  FROM walkthrough_rooms r
  LEFT JOIN properties p_by_id   ON p_by_id.id = r.property_id
  LEFT JOIN properties p_by_addr ON p_by_addr.address = r.building_address;

  SELECT count(*) INTO unresolvable FROM _room_property WHERE property_id IS NULL;
  IF unresolvable > 0 THEN
    -- Not an error: a room whose house was deleted cannot join a walkthrough.
    -- It keeps every column it had and simply has no walkthrough yet, which
    -- loses nothing. Loud so somebody can decide what to do with it.
    RAISE NOTICE 'walkthrough backfill: % room(s) match no property and were left without a walkthrough', unresolvable;
  END IF;

  -- 2. One legacy walkthrough per house that has rooms. Dated from the newest
  --    photo in that house, falling back to the newest room, then to now().
  INSERT INTO walkthroughs (property_id, walkthrough_date, type, status, notes, region, building_address)
  SELECT p.id,
         coalesce(max(ph.uploaded_date), max(r.created_at), now()),
         'legacy',
         'reviewed',
         'Created automatically when dated walkthroughs were introduced. These rooms predate the change, so the date is the most recent activity recorded against them and the inspector is unknown.',
         p.region,
         p.address
  FROM _room_property rp
  JOIN walkthrough_rooms r ON r.id = rp.room_id
  JOIN properties p ON p.id = rp.property_id
  LEFT JOIN walkthrough_photos ph ON ph.room_id = r.id
  GROUP BY p.id, p.region, p.address;

  -- 3. Point every resolvable room at its house's legacy walkthrough.
  UPDATE walkthrough_rooms r
     SET walkthrough_id = w.id
    FROM _room_property rp
    JOIN walkthroughs w ON w.property_id = rp.property_id AND w.type = 'legacy'
   WHERE rp.room_id = r.id
     AND rp.property_id IS NOT NULL;

  -- 4. Each requiredQuestions entry becomes an item. Condition is
  --    'not_recorded': a question is not an assessment.
  INSERT INTO walkthrough_items (room_id, label, condition, display_order)
  SELECT r.id, q.label, 'not_recorded', q.ord - 1
  FROM walkthrough_rooms r
  CROSS JOIN LATERAL unnest(r.required_questions) WITH ORDINALITY AS q(label, ord)
  WHERE r.required_questions IS NOT NULL;

  GET DIAGNOSTICS items_from_q = ROW_COUNT;

  -- 5. A photo marked additional_damage is a claim about state, so it becomes
  --    an item too -- otherwise the flagged-items view would miss every piece
  --    of damage recorded before this change. Its own note carries across; the
  --    photo row itself is untouched.
  INSERT INTO walkthrough_items (room_id, label, condition, notes, display_order)
  SELECT ph.room_id,
         coalesce(nullif(ph.location, ''), r.name),
         'damaged',
         ph.notes,
         1000 + row_number() OVER (PARTITION BY ph.room_id ORDER BY ph.uploaded_date)
  FROM walkthrough_photos ph
  JOIN walkthrough_rooms r ON r.id = ph.room_id
  WHERE ph.condition = 'additional_damage';

  -- 6. Nothing may have been lost or duplicated.
  SELECT count(*) INTO rooms_after  FROM walkthrough_rooms;
  SELECT count(*) INTO photos_after FROM walkthrough_photos;
  SELECT count(*) INTO unassigned
    FROM walkthrough_rooms r JOIN _room_property rp ON rp.room_id = r.id
   WHERE rp.property_id IS NOT NULL AND r.walkthrough_id IS NULL;

  IF rooms_after <> rooms_before THEN
    RAISE EXCEPTION 'walkthrough backfill changed the room count: % before, % after', rooms_before, rooms_after;
  END IF;
  IF photos_after <> photos_before THEN
    RAISE EXCEPTION 'walkthrough backfill changed the photo count: % before, % after', photos_before, photos_after;
  END IF;
  IF items_from_q <> questions_before THEN
    RAISE EXCEPTION 'walkthrough backfill lost checklist questions: % entries before, % items created', questions_before, items_from_q;
  END IF;
  IF unassigned > 0 THEN
    RAISE EXCEPTION 'walkthrough backfill left % room(s) with a known property but no walkthrough', unassigned;
  END IF;

  RAISE NOTICE 'walkthrough backfill: % rooms, % photos preserved; % items from checklist questions', rooms_after, photos_after, items_from_q;
END $$;

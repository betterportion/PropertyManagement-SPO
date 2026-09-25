-- 2026-09 RA review, items 1.2 and 1.4.
--
-- "Annual" is renamed "additional": any inspection that is not a move-in or a
-- move-out. Move-in becomes the default, because that is the one every house
-- gets. Both columns are plain text (0017), so this is a default and a data
-- change, not a type change.
ALTER TABLE "walkthroughs" ALTER COLUMN "type" SET DEFAULT 'move_in';--> statement-breakpoint
UPDATE "walkthroughs" SET "type" = 'additional' WHERE "type" = 'annual';--> statement-breakpoint

-- The national template gains a furnace filter, in the Basement room, unless
-- an admin has already added one. Only the template changes: every walkthrough
-- keeps its own copy, by design (see 0018).
INSERT INTO "walkthrough_template_items" ("template_room_id", "label", "display_order")
SELECT r."id", 'Furnace filter',
       COALESCE((SELECT max(i."display_order") + 1 FROM "walkthrough_template_items" i WHERE i."template_room_id" = r."id"), 0)
FROM "walkthrough_template_rooms" r
WHERE lower(r."name") = 'basement'
  AND NOT EXISTS (
    SELECT 1 FROM "walkthrough_template_items" i
    WHERE i."template_room_id" = r."id" AND lower(i."label") = 'furnace filter'
  );

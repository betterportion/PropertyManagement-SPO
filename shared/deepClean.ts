/**
 * SPO's household deep cleaning instructions, shown on the Resources page at
 * /resources/deep-clean (JR, 2026-11-05: a page in the portal rather than a
 * link, so a student can read it on a phone without a Drive account).
 *
 * The text is SPO's own document ("HH_Deep Clean Instructions"), with only
 * typing slips fixed. This is a copy: when SPO changes their document, change
 * this file to match. It is the one exception to the hub's "links, never
 * documents" rule (.claude/rules/resource-hub.md).
 */
export interface DeepCleanGroup {
  heading?: string;
  items: string[];
  note?: string;
}

export interface DeepCleanArea {
  area: string;
  groups: DeepCleanGroup[];
}

export const DEEP_CLEAN_INTRO: string[] = [
  "Everything gets cleaned. If we do not clean it now, someone else will have to later. We are stewards of this house; how we clean reflects our character. Therefore, every surface, nook and cranny gets wiped down, scrubbed, swept, cleaned, and/or dusted. You will need degreasers, window cleaners, Soft Scrub with Bleach, sponges, rags, scrubbing brushes, brooms, a good vacuum, light bulbs, batteries, oven cleaner, garbage bags, and a lot of elbow grease.",
  "To care for both the property owner and future Household residents, your Household must be cleaned and left in the same or better condition than when you moved in. If there are damages discovered or cleaning needed after you vacate the premises, charges will be assessed to your Household deposit (for common areas, charges will be divided evenly among residents).",
  "In theory, you moved into a perfect working house. If this is not the case, please make your needs known and document those requests so we can follow up on them and be accountable to them.",
];

export const DEEP_CLEAN_AREAS: DeepCleanArea[] = [
  {
    area: "Kitchen",
    groups: [
      {
        heading: "Refrigerator",
        items: [
          "Clean all food out of the refrigerator and either leave it running OR make sure doors are propped open if unplugged.",
          "Clean outside and inside of the refrigerator and freezer thoroughly, removing all debris and stains.",
          "Remove any stickers that you may have put on the refrigerator.",
          "Remove the drawers and clean inside as well as under them, then put them back into place.",
          "Move the refrigerator away from the wall (being careful not to damage the floor) and clean behind it.",
          "Clean the refrigerator drip pans and the front grill at bottom.",
        ],
        note: "Any parts in the refrigerator that are broken or damaged such as clips, racks, drawers, and shelves are expensive to replace because they must be special ordered.",
      },
      {
        heading: "Cabinets/Countertops",
        items: [
          "Empty and clean out all cabinet drawers and tops of cabinets.",
          "Remove or replace cabinet liners as applicable.",
          "Make sure all hardware is cleaned.",
          "Remove any stickers that you may have put on the cabinets and countertops.",
          "Clean counter/bar tops and remove any stains, if possible.",
        ],
        note: "Burns, scratches, and/or chips to the countertop may require that the entire countertop be replaced.",
      },
      {
        heading: "Stove & Oven",
        items: [
          "Clean stove, including under stove burners, control knobs, stove top, and backsplash. If entire stove top lifts up, clean underneath this as well.",
          "Remove any stickers that you may have put on the stove and/or oven.",
          "(If applicable) Glass stove tops must be cleaned with appropriate glass stove top cleaners – no abrasives.",
          "Clean stove rings, drip pans (if applicable), and replace if necessary.",
          "Move the stove away from the wall (being careful not to damage the floor) and clean behind it.",
          "Pull out and clean inside and under bottom drawer of stove (or access panel).",
          "Clean oven, racks, and doors (remember to clean both sides of oven rack).",
          "Clean both top and inside of stove hood, plus the filter and bulbs.",
        ],
        note: "Make sure oven cleaner residue is not left in stove and that stove is not left greasy. After cleaning, turn oven on for a few minutes; if oven turns white, there is still residue from the cleaner. You will need to rinse with plain water again after oven has cooled down.",
      },
      {
        heading: "General Kitchen",
        items: [
          "Clean fire extinguisher and bracket (if applicable), and leave the extinguisher in the bracket.",
          "Clean sink and drain pipes under the sink.",
          "Replace (with proper wattage) burned out or missing light bulbs (inside the refrigerator, stove, hood, over sink, etc.).",
          "Clean inside doors, shelves, and outside of dishwasher and microwave, if provided.",
          "Clean light fixtures.",
          "Make sure windows, window sills, and screens are clean.",
          "Clean baseboards, window sills, and heat ducts.",
          "Wipe down walls and remove any cobwebs.",
          "Remove any nails, tape, or stick-ups from walls, cabinets, windows, and mirrors.",
          "Remove all trash.",
          "Sweep and mop floor.",
        ],
      },
    ],
  },
  {
    area: "Living Room, Dining Room, Family Room",
    groups: [
      {
        items: [
          "Clean baseboards and baseboard heaters.",
          "Clean windows, sills, and screens.",
          "Wipe down walls and remove any cobwebs.",
          "Remove any nails, tape, or stick-ups from walls, being careful not to damage walls.",
          "Clean all light fixtures. If applicable, carefully dust or vacuum the ceiling around fans.",
          "If you have a fireplace, safely dispose of any ashes and wood, then clean the fireplace thoroughly.",
          "Remove all trash.",
          "Vacuum carpets, sweep and mop floors. Spot clean if necessary.",
        ],
      },
    ],
  },
  {
    area: "Hallways and Stairways",
    groups: [
      {
        items: [
          "Clean baseboards.",
          "Make sure all fire prevention alarms and detectors are hooked up properly, have new batteries, and are working.",
          "Remove any nails, tape, or stick-ups from walls, being careful not to damage walls.",
          "Empty hall closets and clean shelves.",
          "Vacuum carpets, sweep and mop floors. Spot clean if necessary.",
        ],
      },
    ],
  },
  {
    area: "Bedrooms",
    groups: [
      {
        items: [
          "Clean baseboards and baseboard heaters, as applicable.",
          "Clean all light fixtures. If applicable, carefully dust or vacuum the ceiling around fans.",
          "Clean windows, sills, and blinds.",
          "Wipe down walls and remove any cobwebs.",
          "Remove any nails, tape, or stick-ups from walls, being careful not to damage walls.",
          "Empty closets and clean shelves.",
          "Vacuum carpets, sweep and mop floors. Spot clean if necessary.",
        ],
      },
    ],
  },
  {
    area: "Bathrooms",
    groups: [
      {
        items: [
          "Clean tub/shower enclosure, sink, and countertop.",
          "Remove all mold, mildew, and soap scum.",
          "Clean around top of tub/shower enclosure.",
          "Clean toilet bowls and lids. Remove anything that may be coloring the water.",
          "Clean toilet tank and around base of toilet.",
          "Clean shower head and all faucets.",
          "Clean medicine cabinets, mirrors, and shelves.",
          "Clean floors and baseboards.",
          "Clean heater grills, vents, and fan grill in ceiling.",
        ],
        note: "If you have a fiberglass shower/tub, use only non-abrasive type cleaners.",
      },
    ],
  },
  {
    area: "Laundry/Utility Room",
    groups: [
      {
        items: [
          "Clean the washing machine inside, outside, control knobs, and behind.",
          "Clean the dryer inside, outside, and carefully clean lint filter.",
          "Dust and clean any shelving.",
          "Clean top of water heater and pan.",
          "Replace furnace and/or air conditioner filters.",
        ],
      },
    ],
  },
  {
    area: "Floors",
    groups: [
      {
        items: [
          "If your Household has wood floors, clean with the appropriate cleaner and refurbish any damage.",
          "Clean tile grout with grout brush.",
        ],
      },
    ],
  },
  {
    area: "Exterior",
    groups: [
      {
        items: [
          "Remove all trash. Do not leave any garbage in the house or outside the door, in or around the yard, driveway, porch, or decks.",
          "Clean decks, patios, porch stoops and front porch area. Clean off exterior doors.",
          "Clean outside light fixtures and make sure they have proper wattage, working light bulbs.",
          "Complete any necessary yard work.",
        ],
      },
    ],
  },
];

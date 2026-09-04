import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb, index, uniqueIndex, boolean, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/**
 * Field builders that reconcile three views of the same value: what a JSON
 * client sends, what the database column stores, and what is actually valid.
 *
 * drizzle-zod derives its types from the column alone -- a numeric column
 * becomes `z.string()`, a timestamp becomes `z.date()` -- but a browser form
 * sends a number for a price and a "YYYY-MM-DD" string for a date. Left as-is
 * the API rejects the very payloads the app produces. These coerce what the
 * client sends, reject nonsensical values, and hand the storage layer the type
 * the column expects.
 */

/** A non-negative amount. Accepts a number or numeric string; stored as the
 *  string the numeric column round-trips as. Rejects NaN, Infinity, negatives. */
const nonNegativeAmount = z.coerce
  .number()
  .finite("Must be a valid number")
  .min(0, "Must be 0 or greater")
  .transform((n: number) => String(n));

/** A non-negative whole count (bedrooms, age, display order). */
const nonNegativeInt = z.coerce
  .number()
  .int("Must be a whole number")
  .min(0, "Must be 0 or greater");

/** A calendar date or timestamp. Accepts the date string a form sends. */
const dateFromClient = z.coerce.date();

/**
 * A link the portal stores and later renders into an `href`.
 *
 * Restricted to http and https on purpose. `new URL()` alone accepts
 * `javascript:`, and every one of these columns is displayed as a clickable
 * link — so a scheme check at the boundary is what stands between a pasted
 * string and script running in a staff member's session. Client-side
 * validation is not that check: the API accepts what the API accepts.
 *
 * An empty string means "cleared", not "invalid": an untouched URL input sends
 * one, and rejecting the whole form for a field nobody filled in would be
 * wrong. It normalises to null.
 */
const httpUrlFromClient = z
  .string()
  .trim()
  .transform((value: string) => (value === "" ? null : value))
  .refine((value: string | null) => {
    if (value === null) return true;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "Enter a full web address starting with http:// or https://");

export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  role: varchar("role", { enum: ["admin", "regional_administrator", "resident"] }).notNull().default("resident"),
  // Which house a resident account belongs to. The two resident logins per
  // property (steward and household leader) both point at their house; staff
  // accounts leave it null. Deleting a property unlinks the accounts rather
  // than deleting them, so the people keep their history.
  propertyId: varchar("property_id").references(() => properties.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const userPermissions = pgTable("user_permissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  canViewMaintenance: boolean("can_view_maintenance").notNull().default(true),
  canManageMaintenance: boolean("can_manage_maintenance").notNull().default(false),
  canViewWalkthroughs: boolean("can_view_walkthroughs").notNull().default(false),
  canManageWalkthroughs: boolean("can_manage_walkthroughs").notNull().default(false),
  canViewAssets: boolean("can_view_assets").notNull().default(false),
  canManageAssets: boolean("can_manage_assets").notNull().default(false),
  canViewBilling: boolean("can_view_billing").notNull().default(false),
  canManageBilling: boolean("can_manage_billing").notNull().default(false),
  canViewContacts: boolean("can_view_contacts").notNull().default(false),
  canManageContacts: boolean("can_manage_contacts").notNull().default(false),
  canManageUsers: boolean("can_manage_users").notNull().default(false),
  canViewProperties: boolean("can_view_properties").notNull().default(false),
  canManageProperties: boolean("can_manage_properties").notNull().default(false),
  // Resident finances (rent charges and security deposits). Historically this
  // was role-gated to all staff; the flags exist so finance can later be split
  // out of admin as a grant rather than a guard rewrite. The migration that
  // added them backfilled both to true for existing staff.
  canViewFinancials: boolean("can_view_financials").notNull().default(false),
  canManageFinancials: boolean("can_manage_financials").notNull().default(false),
  // Walkthrough completion by a resident-tier account -- the household leader
  // and the steward, the only two residents per property who ever have a login.
  // Deliberately separate from canManageWalkthroughs: that flag is the staff
  // grant and carries region scope, this one carries none and is only ever
  // house-scoped. Granted by hand per account; no role gets it by default.
  canCompleteWalkthroughs: boolean("can_complete_walkthroughs").notNull().default(false),
  // The per-property setup checklist (utilities, insurance, startup budget).
  // Granted by hand rather than by role so that the first feature to use it
  // starts from nobody, not from everybody; admins bypass it as they bypass
  // every flag.
  canManagePropertySetup: boolean("can_manage_property_setup").notNull().default(false),
  // The resource hub -- the one page a household leader or steward goes to.
  // A separate flag rather than reading canCompleteWalkthroughs, for the same
  // reason that flag is separate from canManageWalkthroughs: they are
  // different grants, and honouring one for the other means a later change to
  // either silently moves the other. Granted by hand per account; no role gets
  // it by default.
  canViewResourceHub: boolean("can_view_resource_hub").notNull().default(false),
  allowedRegions: text("allowed_regions").array().default([]),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertUserPermissionsSchema = createInsertSchema(userPermissions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type UpsertUser = typeof users.$inferInsert;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type UserPermissions = typeof userPermissions.$inferSelect;
export type InsertUserPermissions = z.infer<typeof insertUserPermissionsSchema>;

// Maintenance Requests
export const maintenanceRequests = pgTable("maintenance_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: varchar("title").notNull(),
  description: text("description").notNull(),
  category: varchar("category").notNull(),
  priority: varchar("priority", { enum: ["low", "medium", "high", "urgent", "wishlist"] }).notNull(),
  status: varchar("status", { enum: ["pending", "in_progress", "completed", "cancelled"] }).notNull().default("pending"),
  location: varchar("location").notNull(),
  region: varchar("region").notNull(),
  buildingAddress: varchar("building_address").notNull(),
  submittedBy: varchar("submitted_by").notNull(),
  submittedDate: timestamp("submitted_date").defaultNow(),
  completedDate: timestamp("completed_date"),
  photoUrl: varchar("photo_url"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * The statuses that mean a request is finished.
 *
 * Beside the table whose column it describes, and shared, because three
 * separate places decide what "closed" means: the close-date stamping in
 * server/maintenanceStatus.ts, the resident visibility window in
 * server/authz.ts, and the range filter on the maintenance list. Adding a
 * fifth status with three copies of this list would silently widen or narrow
 * what a household leader can read, which is the quietest possible way to get
 * an authorization rule wrong.
 *
 * `cancelled` counts. `completedDate` is the *close* date and is stamped for a
 * cancelled request too, so a cancelled request is finished work.
 */
export const CLOSED_MAINTENANCE_STATUSES = ["completed", "cancelled"] as const;

export function isClosedMaintenanceStatus(status: string | null | undefined): boolean {
  return status != null && (CLOSED_MAINTENANCE_STATUSES as readonly string[]).includes(status);
}

export const insertMaintenanceRequestSchema = createInsertSchema(maintenanceRequests).omit({
  id: true,
  submittedDate: true,
  completedDate: true,
  createdAt: true,
  updatedAt: true,
});

export type MaintenanceRequest = typeof maintenanceRequests.$inferSelect;
export type InsertMaintenanceRequest = z.infer<typeof insertMaintenanceRequestSchema>;

// Walkthrough Rooms (templates)
export const walkthroughRooms = pgTable("walkthrough_rooms", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  // A room now belongs to a dated walkthrough rather than straight to a house,
  // so the same kitchen appears once per inspection and can be compared year
  // over year. Nullable only because the column has to exist before the
  // backfill can populate it; every row is set by the end of that migration.
  walkthroughId: varchar("walkthrough_id").references(() => walkthroughs.id, { onDelete: "cascade" }),
  propertyId: varchar("property_id"), // References properties table
  buildingAddress: varchar("building_address").notNull(), // Kept for backward compatibility
  // Legacy. This text array was the only per-item detail the old shape held;
  // the backfill turned each entry into a walkthrough_items row. Kept rather
  // than dropped so the migration stays reversible by inspection.
  requiredQuestions: text("required_questions").array(),
  displayOrder: integer("display_order").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertWalkthroughRoomSchema = createInsertSchema(walkthroughRooms)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    displayOrder: nonNegativeInt,
  });

export type WalkthroughRoom = typeof walkthroughRooms.$inferSelect;
export type InsertWalkthroughRoom = z.infer<typeof insertWalkthroughRoomSchema>;

/**
 * The condition vocabulary for a walkthrough item.
 *
 * Two kinds of "no grade" here, and they are not the same thing:
 *   - `not_applicable` -- the item does not exist in this house. No smoke
 *     detector in a room that has none.
 *   - `not_recorded` -- the item exists and nobody assessed it. Every item the
 *     backfill created from legacy data is this, because the old vocabulary
 *     recorded *change* ("same as last walkthrough") rather than *state*, and
 *     "nothing changed" says nothing about whether a room is good or poor.
 *
 * Collapsing the two would either hide a real gap in the record or invent a
 * clean bill of health for a room nobody looked at.
 */
export const WALKTHROUGH_CONDITIONS = [
  "good",
  "fair",
  "poor",
  "damaged",
  "not_applicable",
  "not_recorded",
] as const;

export type WalkthroughCondition = (typeof WALKTHROUGH_CONDITIONS)[number];

/** The conditions the flagged-items view treats as needing attention. */
export const WALKTHROUGH_FLAGGED_CONDITIONS = ["poor", "damaged"] as const;

// Walkthrough template
//
// One national template: the standard rooms, and the standard items in each.
// It does two jobs, which is why it is one table pair rather than two:
//
//   1. The rooms marked includeByDefault are copied to a property on its FIRST
//      walkthrough, so an RA starts from a filled-in checklist rather than a
//      blank page.
//   2. Every room is a known room TYPE. Adding a bathroom to a walkthrough
//      later copies that room's standard items -- sink, toilet, tub, shower --
//      so the RA deletes what is not there instead of typing what is.
//
// A property's walkthrough owns COPIES of these rows, never references to
// them. That is what makes "editing the global template never retroactively
// changes a property's copy" true by construction rather than by care.
export const walkthroughTemplateRooms = pgTable("walkthrough_template_rooms", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  // Whether a property's first walkthrough starts with this room. A garage is
  // a known room type but not every house has one.
  includeByDefault: boolean("include_by_default").notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertWalkthroughTemplateRoomSchema = createInsertSchema(walkthroughTemplateRooms)
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({ displayOrder: nonNegativeInt });

export type WalkthroughTemplateRoom = typeof walkthroughTemplateRooms.$inferSelect;
export type InsertWalkthroughTemplateRoom = z.infer<typeof insertWalkthroughTemplateRoomSchema>;

export const walkthroughTemplateItems = pgTable("walkthrough_template_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  templateRoomId: varchar("template_room_id")
    .notNull()
    .references(() => walkthroughTemplateRooms.id, { onDelete: "cascade" }),
  label: varchar("label").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertWalkthroughTemplateItemSchema = createInsertSchema(walkthroughTemplateItems)
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({ displayOrder: nonNegativeInt });

export type WalkthroughTemplateItem = typeof walkthroughTemplateItems.$inferSelect;
export type InsertWalkthroughTemplateItem = z.infer<typeof insertWalkthroughTemplateItemSchema>;

// Walkthroughs
//
// A dated inspection event for one house. This is the record that did not
// exist before: rooms hung straight off a property, so there was nothing to
// compare year over year and no record of who filled an inspection in.
//
// region and buildingAddress are denormalised from the property, exactly as on
// residents and maintenance schedules, so region-scoped authorization applies
// without a join.
export const walkthroughs = pgTable("walkthroughs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: varchar("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  walkthroughDate: timestamp("walkthrough_date").notNull().defaultNow(),
  type: varchar("type", { enum: ["move_in", "move_out", "annual", "legacy"] }).notNull().default("annual"),
  // draft survives leaving the page half-finished, which is the normal case
  // for somebody filling this in on a phone while walking around a house.
  status: varchar("status", { enum: ["draft", "submitted", "reviewed"] }).notNull().default("draft"),
  performedBy: varchar("performed_by"),
  notes: text("notes"),
  region: varchar("region").notNull(),
  buildingAddress: varchar("building_address").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertWalkthroughSchema = createInsertSchema(walkthroughs)
  .omit({ id: true, createdAt: true, updatedAt: true })
  // Optional rather than nullable: the column is NOT NULL with a default, so
  // an omitted date means "now", and an explicit null is a caller error.
  .extend({ walkthroughDate: dateFromClient.optional() });

export type Walkthrough = typeof walkthroughs.$inferSelect;
export type InsertWalkthrough = z.infer<typeof insertWalkthroughSchema>;

// Walkthrough Items
//
// One line of a room's checklist: the sink, the smoke detector, the walls.
// This is where condition and notes now live. They used to live on a photo,
// which meant an item nobody photographed could not be assessed at all.
export const walkthroughItems = pgTable("walkthrough_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  roomId: varchar("room_id").notNull().references(() => walkthroughRooms.id, { onDelete: "cascade" }),
  label: varchar("label").notNull(),
  condition: varchar("condition", { enum: WALKTHROUGH_CONDITIONS }).notNull().default("not_recorded"),
  notes: text("notes"),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertWalkthroughItemSchema = createInsertSchema(walkthroughItems)
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({ displayOrder: nonNegativeInt });

export type WalkthroughItem = typeof walkthroughItems.$inferSelect;
export type InsertWalkthroughItem = z.infer<typeof insertWalkthroughItemSchema>;

/**
 * One flagged checklist item, carrying enough of its room, walkthrough and
 * house to be read on a list without a second request per row.
 *
 * The stated pain point this answers is a deep hole in a wall surfacing
 * without somebody opening every walkthrough one by one. That means the row
 * has to name the house and the room, not just the item -- so this is a
 * flattened read shape rather than a `WalkthroughItem`, and it is assembled by
 * one join in the storage layer rather than N+1 lookups in a handler.
 *
 * Deliberately not a table. Nothing is stored in this shape; it exists only
 * as the answer to one query.
 */
export interface FlaggedWalkthroughItem {
  itemId: string;
  label: string;
  condition: WalkthroughCondition;
  notes: string | null;
  roomId: string;
  roomName: string;
  walkthroughId: string;
  walkthroughDate: Date | string;
  walkthroughType: Walkthrough["type"];
  walkthroughStatus: Walkthrough["status"];
  propertyId: string;
  buildingAddress: string;
  region: string;
  /** How many photos the room carries, so a row can say whether there is one. */
  roomPhotoCount: number;
}

// Walkthrough Photos
export const walkthroughPhotos = pgTable("walkthrough_photos", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  roomId: varchar("room_id").notNull().references(() => walkthroughRooms.id, { onDelete: "cascade" }),
  imageUrl: varchar("image_url").notNull(),
  // Legacy, and deliberately not dropped. This vocabulary records *change*
  // since the last visit, not *state*, so it cannot be reinterpreted as a
  // condition -- see WALKTHROUGH_CONDITIONS. Condition now lives on
  // walkthrough_items; this column is nullable so new photos need not set it,
  // and the existing values stay exactly as they were recorded.
  condition: varchar("condition", { enum: ["same_as_last_walkthrough", "additional_damage"] }),
  notes: text("notes"),
  region: varchar("region").notNull(),
  buildingAddress: varchar("building_address").notNull(),
  location: varchar("location").notNull(),
  uploadedBy: varchar("uploaded_by").notNull(),
  uploadedDate: timestamp("uploaded_date").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertWalkthroughPhotoSchema = createInsertSchema(walkthroughPhotos).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type WalkthroughPhoto = typeof walkthroughPhotos.$inferSelect;
export type InsertWalkthroughPhoto = z.infer<typeof insertWalkthroughPhotoSchema>;

// Appliances/Fixed Assets (renamed from Fixed Assets)
export const assets = pgTable("assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  category: varchar("category").notNull(),
  type: varchar("type", { enum: ["fixed", "movable"] }).notNull(),
  ageInYears: integer("age_in_years").notNull(),
  lastServiced: timestamp("last_serviced"),
  serialNumber: varchar("serial_number"),
  purchasePrice: numeric("purchase_price", { precision: 12, scale: 2 }),
  assetTagId: varchar("asset_tag_id"),
  propertyId: varchar("property_id"), // References properties table
  location: varchar("location").notNull(),
  // ── Lifecycle ────────────────────────────────────────────────────────────
  // When SPO got it. Nullable and stays that way: tracking is admittedly
  // patchy, and an asset without one is UNRATED rather than guessed at. The
  // legacy `ageInYears` above is kept because it is what existing rows have,
  // but nothing computes a replacement date from it -- a whole-number age with
  // no reference point cannot be turned back into a date.
  acquisitionDate: timestamp("acquisition_date"),
  // Per-asset override of the category default in shared/assetLifecycle.ts.
  // The category carries the default because per-asset entry alone would be
  // mostly blank.
  expectedLifespanYears: integer("expected_lifespan_years"),
  // An explicit date, which beats anything computed. Editing this is the
  // PERMANENT correction; the snooze below is the temporary one.
  replacementDueDate: timestamp("replacement_due_date"),
  // ── Snooze ───────────────────────────────────────────────────────────────
  // An RA confident a boiler has more life in it needs to clear it from view
  // without falsifying the date. It records who, when, why and until when, and
  // it returns. The reason is the point -- it is what makes next year's budget
  // conversation possible.
  snoozedUntil: timestamp("snoozed_until"),
  snoozeReason: text("snooze_reason"),
  snoozedByUserId: varchar("snoozed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  snoozedAt: timestamp("snoozed_at"),
  // ── Value ────────────────────────────────────────────────────────────────
  // Alongside purchasePrice, never replacing it: used equipment can be worth
  // more than it cost, insurance cares about value rather than purchase price,
  // and dropping the purchase price would lose history nothing can rebuild.
  currentValue: numeric("current_value", { precision: 12, scale: 2 }),
  valuedOn: timestamp("valued_on"),
  // ── Assignment (movable assets) ──────────────────────────────────────────
  // Optional, and a real reference wherever one exists -- a resident or a staff
  // account -- with free text only as the fallback for somebody who is neither.
  // The use case is a staff departure: collect the iPad, the guitar and the
  // laptop before he leaves.
  assignedResidentId: varchar("assigned_resident_id").references(() => residents.id, { onDelete: "set null" }),
  assignedUserId: varchar("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
  assignedToName: varchar("assigned_to_name"),
  expectedReturnDate: timestamp("expected_return_date"),
  // ── Provenance ───────────────────────────────────────────────────────────
  // Where it came from and how the experience went. Institutional memory that
  // currently dies at RA handover.
  acquisitionNotes: text("acquisition_notes"),
  supplierContactId: varchar("supplier_contact_id").references(() => maintenanceContacts.id, { onDelete: "set null" }),
  region: varchar("region").notNull(),
  buildingAddress: varchar("building_address").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAssetSchema = createInsertSchema(assets)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .omit({
    // The WHOLE snooze is server-owned, not just its attribution.
    //
    // Omitting only the actor and the timestamp left the ordinary asset PATCH
    // able to set `snoozedUntil` directly -- and since `assetLifecycle` reads
    // the snooze off that column alone, an asset could be cleared from the
    // dashboard with no reason, no actor and no date recorded, which is
    // exactly what the dedicated route exists to prevent. Every guarantee that
    // route makes is only worth as much as the sibling paths that cannot make
    // it. The snooze routes are the only writers.
    snoozedUntil: true,
    snoozeReason: true,
    snoozedByUserId: true,
    snoozedAt: true,
  })
  .extend({
    ageInYears: nonNegativeInt,
    purchasePrice: nonNegativeAmount.nullish(),
    currentValue: nonNegativeAmount.nullish(),
    lastServiced: dateFromClient.nullish(),
    acquisitionDate: dateFromClient.nullish(),
    replacementDueDate: dateFromClient.nullish(),
    expectedReturnDate: dateFromClient.nullish(),
    valuedOn: dateFromClient.nullish(),
    expectedLifespanYears: nonNegativeInt.nullish(),
  });

export type Asset = typeof assets.$inferSelect;
export type InsertAsset = z.infer<typeof insertAssetSchema>;

// Asset Photos
export const assetPhotos = pgTable("asset_photos", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  assetId: varchar("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  imageUrl: varchar("image_url").notNull(),
  caption: text("caption"),
  uploadedBy: varchar("uploaded_by").notNull(),
  uploadedDate: timestamp("uploaded_date").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAssetPhotoSchema = createInsertSchema(assetPhotos).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type AssetPhoto = typeof assetPhotos.$inferSelect;
export type InsertAssetPhoto = z.infer<typeof insertAssetPhotoSchema>;

// Maintenance Request Photos
//
// Photos of the problem, attached to a maintenance request. A resident may add
// a few when they report an issue (the request's single legacy `photoUrl` stays
// for staff-added photos). `imageUrl` holds the "/uploads/<key>" URL; download
// access inherits the request's visibility via findUploadReferences +
// canReadUploadReference (a resident sees only their own request's photos).
export const maintenanceRequestPhotos = pgTable("maintenance_request_photos", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  requestId: varchar("request_id").notNull().references(() => maintenanceRequests.id, { onDelete: "cascade" }),
  imageUrl: varchar("image_url").notNull(),
  uploadedBy: varchar("uploaded_by").notNull(),
  uploadedDate: timestamp("uploaded_date").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertMaintenanceRequestPhotoSchema = createInsertSchema(maintenanceRequestPhotos).omit({
  id: true,
  // Server-owned: taken from the authenticated actor, never a request body.
  uploadedBy: true,
  createdAt: true,
  updatedAt: true,
});

export type MaintenanceRequestPhoto = typeof maintenanceRequestPhotos.$inferSelect;
export type InsertMaintenanceRequestPhoto = z.infer<typeof insertMaintenanceRequestPhotoSchema>;

/**
 * The thread on a request: what the handyman said on the phone, who is coming
 * when, what it cost -- kept here instead of evaporating out of text messages.
 *
 * `isInternal` defaults to true because an RA will paste "he quoted $4,200"
 * into an ordinary repair's thread, and if the default were shared a
 * household would learn that the wrong way. Visibility is fixed at posting:
 * there is no route that changes it, and no route that edits a body, so a
 * dated comment stays the record of what was said at the time. Deletable.
 *
 * A relayed comment is one an RA posts on a contractor's behalf. `relaySource`
 * is what renders ("Dave (handyman)"); `relayContactId` is the optional link
 * to the contractor's record, set null when that record goes.
 */
export const maintenanceRequestComments = pgTable("maintenance_request_comments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  requestId: varchar("request_id").notNull().references(() => maintenanceRequests.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  isInternal: boolean("is_internal").notNull().default(true),
  // Set null rather than restrict, as contact notes do: the comment outlives
  // the account, and the name and email kept alongside still say who wrote it.
  authorUserId: varchar("author_user_id").references(() => users.id, { onDelete: "set null" }),
  authorEmail: varchar("author_email"),
  authorName: varchar("author_name"),
  relaySource: varchar("relay_source"),
  relayContactId: varchar("relay_contact_id").references(() => maintenanceContacts.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("maintenance_request_comments_request_idx").on(table.requestId),
]);

export const insertMaintenanceRequestCommentSchema = createInsertSchema(maintenanceRequestComments)
  .omit({
    id: true,
    // Server-owned: the request comes from the URL and the author from the
    // session. A comment whose author the client chose would be worth nothing.
    requestId: true,
    authorUserId: true,
    authorEmail: true,
    authorName: true,
    createdAt: true,
  })
  .extend({
    // The body's whitespace and length rules live in server/comments.ts, in
    // one place; here only "something was typed" is checked.
    body: z.string().trim().min(1, "Write something first"),
    relaySource: z.string().trim().max(120).nullish(),
    relayContactId: z.string().nullish(),
  });

export type MaintenanceRequestComment = typeof maintenanceRequestComments.$inferSelect;
export type InsertMaintenanceRequestComment = z.infer<typeof insertMaintenanceRequestCommentSchema>;

// Maintenance Contacts
export const maintenanceContacts = pgTable("maintenance_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  company: varchar("company").notNull(),
  service: varchar("service").notNull(),
  phone: varchar("phone").notNull(),
  email: varchar("email").notNull(),
  region: varchar("region").notNull(),
  buildingAddress: varchar("building_address").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertMaintenanceContactSchema = createInsertSchema(maintenanceContacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

/**
 * Dated notes on a vendor.
 *
 * What an RA learned working with somebody: they turned up late twice, they
 * are the only ones who will touch this boiler, do not use them for tile. That
 * knowledge currently dies at RA handover, which is the whole reason this
 * exists.
 *
 * **There is deliberately no rating field.** A star score on a vendor SPO may
 * have to keep using invites arguments about the number, and tells an incoming
 * RA far less than a paragraph does. Dated entries in somebody's own words are
 * the record worth keeping.
 *
 * Notes are append-and-delete rather than editable: a dated note somebody
 * revised later is no longer the record of what they thought at the time.
 * `region` is denormalised from the contact so region scoping applies without
 * a join, as everywhere else.
 */
export const contactNotes = pgTable("contact_notes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contactId: varchar("contact_id").notNull().references(() => maintenanceContacts.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  // Set null rather than restrict: the note outlives the RA who wrote it, and
  // deleting a user must never be blocked.
  authorUserId: varchar("author_user_id").references(() => users.id, { onDelete: "set null" }),
  /** Kept alongside the id so a deleted account's note still says who wrote it. */
  authorEmail: varchar("author_email"),
  region: varchar("region").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertContactNoteSchema = createInsertSchema(contactNotes)
  .omit({
    id: true,
    // Server-owned: the author and the region come from the session and the
    // contact. A note whose author the client chose is worth nothing.
    authorUserId: true,
    authorEmail: true,
    region: true,
    contactId: true,
    createdAt: true,
  })
  .extend({
    body: z
      .string()
      .trim()
      .min(1, "Write something — an empty note tells the next RA nothing")
      .max(2000, "Keep the note under 2000 characters"),
  });

export type ContactNote = typeof contactNotes.$inferSelect;
export type InsertContactNote = z.infer<typeof insertContactNoteSchema>;

export type MaintenanceContact = typeof maintenanceContacts.$inferSelect;
export type InsertMaintenanceContact = z.infer<typeof insertMaintenanceContactSchema>;

// Invoices (separated from contacts)
export const invoices = pgTable("invoices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  invoiceNumber: varchar("invoice_number").notNull(),
  contactId: varchar("contact_id").references(() => maintenanceContacts.id, { onDelete: "set null" }),
  maintenanceRequestId: varchar("maintenance_request_id").references(() => maintenanceRequests.id, { onDelete: "set null" }),
  service: varchar("service").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  status: varchar("status", { enum: ["pending", "paid", "overdue", "cancelled"] }).notNull().default("pending"),
  dueDate: timestamp("due_date").notNull(),
  paidDate: timestamp("paid_date"),
  region: varchar("region").notNull(),
  buildingAddress: varchar("building_address").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertInvoiceSchema = createInsertSchema(invoices)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    amount: nonNegativeAmount,
    dueDate: dateFromClient,
    paidDate: dateFromClient.nullish(),
  });

export type Invoice = typeof invoices.$inferSelect;
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;

// Billing Records
export const billingRecords = pgTable("billing_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contactId: varchar("contact_id"),
  companyName: varchar("company_name").notNull(),
  email: varchar("email").notNull(),
  phone: varchar("phone").notNull(),
  invoiceCost: numeric("invoice_cost", { precision: 12, scale: 2 }).notNull(),
  contractInvoiceUrl: varchar("contract_invoice_url"),
  coiUrl: varchar("coi_url"),
  w9Url: varchar("w9_url"),
  // Billing records were previously visible to every user who held the billing
  // permission, because there was nothing on the row to scope them by. The
  // column defaults to "" so an existing database can adopt it without a
  // backfill step; an empty region is treated as inaccessible to non-admins,
  // which fails closed rather than exposing legacy rows.
  region: varchar("region").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertBillingRecordSchema = createInsertSchema(billingRecords)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  // The column default makes region optional for inserts, but a record created
  // through the API must always name its region -- otherwise new rows would be
  // born invisible to everyone except admins.
  .extend({
    region: z.string().min(1, "Region is required"),
    invoiceCost: nonNegativeAmount,
  });

export type BillingRecord = typeof billingRecords.$inferSelect;
export type InsertBillingRecord = z.infer<typeof insertBillingRecordSchema>;

// Properties
export const properties = pgTable("properties", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  streetAddress: varchar("street_address").notNull(),
  city: varchar("city").notNull(),
  state: varchar("state").notNull(),
  zipCode: varchar("zip_code").notNull(),
  address: varchar("address").notNull().unique(), // Computed: streetAddress, city, state zipCode
  region: varchar("region").notNull(),
  // Which SPO chapter uses the property. Free text: chapter names vary and
  // are typed by admins, so the Properties page filter builds its options
  // from the values actually stored rather than a fixed list.
  chapter: varchar("chapter"),
  propertyManager: varchar("property_manager"),
  bedrooms: integer("bedrooms"),
  bathrooms: numeric("bathrooms", { precision: 3, scale: 1 }),
  squareFootage: integer("square_footage"),
  // Lease tracking. SPO owns some houses and rents others; the lease fields
  // only apply when `ownership` is "rented". `leaseRenewalDate` is what the
  // 2-months-out renewal reminder watches; `renewalDecision` records the RA's
  // call so a house marked "not_renewing" drops off the reminders.
  ownership: varchar("ownership", { enum: ["owned", "rented"] }).notNull().default("owned"),
  leaseStartDate: timestamp("lease_start_date"),
  leaseEndDate: timestamp("lease_end_date"),
  leaseRenewalDate: timestamp("lease_renewal_date"),
  renewalDecision: varchar("renewal_decision", { enum: ["undecided", "renewing", "not_renewing"] }).notNull().default("undecided"),
  // A link to the lease on Drive, never the document itself. Settled with SPO:
  // no lease documents are uploaded into the portal. The recurring complaint
  // was that the current lease is hard to find, and a link solves that without
  // the portal becoming a document store it would then have to secure.
  leaseDocumentUrl: varchar("lease_document_url"),
  // Where a rented house's repairs are actually filed. A URL and a contact --
  // never a stored login, per the financial and credential rules.
  maintenancePortalUrl: varchar("maintenance_portal_url"),
  // Who to call. Two columns rather than one because they mean different
  // things: a rented house has a rental company, an owned one has whoever SPO
  // makes responsible. Set null on delete so removing a vendor never deletes
  // a house.
  rentalCompanyContactId: varchar("rental_company_contact_id").references(() => maintenanceContacts.id, { onDelete: "set null" }),
  responsibleContactId: varchar("responsible_contact_id").references(() => maintenanceContacts.id, { onDelete: "set null" }),
  // One front-of-house photo, replaceable. Holds the "/uploads/<key>" URL, and
  // download access is authorized against the property through
  // findUploadReferences -- which is why authz.ts had to learn about
  // properties at all.
  photoUrl: varchar("photo_url"),
  notes: text("notes"),
  // ── Deposits ─────────────────────────────────────────────────────────────
  // The deposit this house takes, with a per-person override on each
  // resident's own record. A house figure with an override beats asking an RA
  // to retype the same number eight times every August.
  depositAmount: numeric("deposit_amount", { precision: 12, scale: 2 }),
  // How many days after a resident moves out SPO means to have their deposit
  // back. An ADMIN-SET NUMBER PER PROPERTY, never a lookup: the states SPO
  // operates in have materially different rules -- Arizona counts business
  // days, Florida and Kansas are two-stage -- and a state-to-deadline table
  // would bake legal advice into the repo and go stale silently. SPO's admin
  // and finance teams are responsible for compliance; the portal reminds.
  depositReturnDays: integer("deposit_return_days"),
  /** What that number is based on, in SPO's own words. */
  depositNotes: text("deposit_notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertPropertySchema = createInsertSchema(properties)
  .omit({
    id: true,
    address: true, // Computed from streetAddress, city, state, zipCode
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    // Required to save, alongside the four address parts, region and
    // ownership. The COLUMN stays nullable: houses created before this rule
    // have no chapter, and a NOT NULL migration would either fail or invent
    // one for them. The boundary is where the rule belongs.
    chapter: z.string().trim().min(1, "Which SPO chapter uses this house?"),
    // Rendered into an href on the property page, so the scheme is checked
    // here rather than only in the form -- see httpUrlFromClient.
    leaseDocumentUrl: httpUrlFromClient.nullish(),
    maintenancePortalUrl: httpUrlFromClient.nullish(),
    bedrooms: nonNegativeInt.nullish(),
    bathrooms: nonNegativeAmount.nullish(),
    squareFootage: nonNegativeInt.nullish(),
    leaseStartDate: dateFromClient.nullish(),
    leaseEndDate: dateFromClient.nullish(),
    leaseRenewalDate: dateFromClient.nullish(),
    depositAmount: nonNegativeAmount.nullish(),
    depositReturnDays: nonNegativeInt.nullish(),
  });

/**
 * The per-property setup checklist: one row per item per house.
 *
 * A dedicated table rather than a `tasks` row, settled and recorded in
 * shared/propertySetup.ts. What lives here is only the state; the item list
 * itself is fixed in code, which is why the row stores `itemKey` rather than a
 * label -- if SPO later edits the list themselves it becomes a config table
 * and these rows keep working unchanged.
 *
 * Every row records who set it and when, because "who said the gas was on" is
 * the question that actually gets asked. `region` is denormalised from the
 * property, as on residents and schedules, so region scoping applies without a
 * join.
 *
 * Rows are generated on property creation only and deliberately never
 * backfilled: a house with no rows is untracked rather than incomplete. See
 * summarizeSetup.
 */
export const propertySetupItems = pgTable(
  "property_setup_items",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    propertyId: varchar("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    /** Matches a key in SETUP_ITEMS. Not an enum column: the list is code, and
     *  a database enum would need a migration every time SPO adds an item. */
    itemKey: varchar("item_key").notNull(),
    status: varchar("status", { enum: ["open", "done", "not_applicable"] }).notNull().default("open"),
    note: text("note"),
    // Set null rather than restrict: the checklist outlives the RA who filled
    // it in, and deleting a user must never be blocked.
    setByUserId: varchar("set_by_user_id").references(() => users.id, { onDelete: "set null" }),
    setAt: timestamp("set_at"),
    region: varchar("region").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [uniqueIndex("IDX_property_setup_item").on(table.propertyId, table.itemKey)],
);

export const insertPropertySetupItemSchema = createInsertSchema(propertySetupItems)
  .omit({
    id: true,
    // Server-owned: taken from the authenticated actor and the clock, never a
    // request body. "Who said the gas was on" is worthless if the client says.
    setByUserId: true,
    setAt: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    note: z.string().trim().max(500, "Keep the note under 500 characters").nullish(),
  });

/**
 * What a caller may actually send when setting one checklist item.
 *
 * Picked from the schema above rather than written out again: the status
 * vocabulary and the 500-character limit have exactly one definition, and a
 * later change to either cannot leave the route enforcing the old one. The
 * property and the item come from the URL; the region, the actor and the
 * timestamp come from the server.
 */
export const setPropertySetupItemSchema = insertPropertySetupItemSchema.pick({
  status: true,
  note: true,
});

export type PropertySetupItem = typeof propertySetupItems.$inferSelect;
export type InsertPropertySetupItem = z.infer<typeof insertPropertySetupItemSchema>;

export type Property = typeof properties.$inferSelect;
export type InsertProperty = z.infer<typeof insertPropertySchema>;
// Type for creating/updating properties with computed address
export type InsertPropertyWithAddress = InsertProperty & { address: string };

// Residents
//
// Who is living in each house. The roster is the foundation the money features
// (monthly rent status, security deposits -- issue #40) and the departing-
// resident email (issue #41) hang off, but this table deliberately holds only
// the roster itself: a person, the house they occupy, and when they moved in
// and out. Money is a separate, permission-gated concern and lives elsewhere.
//
// region and buildingAddress are denormalised from the property, exactly as on
// assets and maintenance schedules, so the same region-scoped authorization
// applies without a join. A resident is never deleted by history: moving out
// sets moveOutDate and clears isActive, so who lived where survives turnover.
export const residents = pgTable("residents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: varchar("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  firstName: varchar("first_name").notNull(),
  lastName: varchar("last_name").notNull(),
  email: varchar("email").notNull(),
  // Nullable on purpose. A roster imported from a spreadsheet often has no
  // phone number, and requiring one would mean either inventing a value or
  // dropping the row. Nothing in the portal sends an SMS -- group texting is
  // deliberately not built (see CLAUDE.md) -- so this is a contact detail an
  // RA reads, not a channel the app uses.
  phone: varchar("phone"),
  notes: text("notes"),
  /** Overrides the house's `depositAmount` for this person. Null means the
   *  house figure applies -- a scholarship or a partial term is a different
   *  number, not a different model. */
  depositAmountOverride: numeric("deposit_amount_override", { precision: 12, scale: 2 }),
  moveInDate: timestamp("move_in_date"),
  moveOutDate: timestamp("move_out_date"),
  isActive: boolean("is_active").notNull().default(true),
  region: varchar("region").notNull(),
  buildingAddress: varchar("building_address").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertResidentSchema = createInsertSchema(residents)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    email: z.string().email("Enter a valid email address"),
    depositAmountOverride: nonNegativeAmount.nullish(),
    moveInDate: dateFromClient.nullish(),
    moveOutDate: dateFromClient.nullish(),
  });

export type Resident = typeof residents.$inferSelect;
export type InsertResident = z.infer<typeof insertResidentSchema>;

// Rent payments
//
// One row per resident per month. Rent is billed monthly (decided with SPO,
// issue #43); "flat per house" is an ergonomic concern, not a schema one -- the
// generate action fills the same amount for every resident in a house, but the
// amount lives on each row so a scholarship or a partial month is just a
// different number. The unique index on (residentId, period) keeps that action
// idempotent: re-running it never creates a second charge for the same month.
//
// This is finance data: it is gated to regional leads (admins + regional
// administrators), not to the property permission the roster uses, and it holds
// amounts, statuses, dates and a free-text reference ONLY -- never a bank
// account, routing, or card number (see the financial-data rule in CLAUDE.md).
export const rentPayments = pgTable(
  "rent_payments",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    residentId: varchar("resident_id").notNull().references(() => residents.id, { onDelete: "cascade" }),
    propertyId: varchar("property_id").notNull(),
    // The month being billed, as "YYYY-MM".
    period: varchar("period").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    // "failed" is a payment that bounced — it surfaces the resident in the
    // outstanding-fees view rather than quietly reverting to "unpaid".
    status: varchar("status", { enum: ["unpaid", "paid", "waived", "failed"] }).notNull().default("unpaid"),
    paidDate: timestamp("paid_date"),
    // How it was paid, e.g. "check #1234" or a QuickBooks/Ramp reference. Never
    // an account or card number.
    reference: varchar("reference"),
    notes: text("notes"),
    region: varchar("region").notNull(),
    buildingAddress: varchar("building_address").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [uniqueIndex("IDX_rent_payment_resident_period").on(table.residentId, table.period)],
);

export const insertRentPaymentSchema = createInsertSchema(rentPayments)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    period: z.string().regex(/^\d{4}-\d{2}$/, "Use a YYYY-MM month"),
    amount: nonNegativeAmount,
    paidDate: dateFromClient.nullish(),
  });

export type RentPayment = typeof rentPayments.$inferSelect;
export type InsertRentPayment = z.infer<typeof insertRentPaymentSchema>;

// Security deposits
//
// One deposit per resident (unique). Tracks the current status and any
// deductions as a note (decided with SPO, issue #43) -- enough to drive the
// departing-resident email (#41) without an itemised ledger. Same finance
// gating and same financial-data rule as rent: amounts, statuses, dates and
// notes only, never bank/card details.
export const securityDeposits = pgTable(
  "security_deposits",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    residentId: varchar("resident_id").notNull().references(() => residents.id, { onDelete: "cascade" }),
    propertyId: varchar("property_id").notNull(),
    amountHeld: numeric("amount_held", { precision: 12, scale: 2 }).notNull(),
    // "statement_sent" is added rather than replacing the vocabulary: existing
    // rows already carry the other four, and renaming a stored status leaves
    // history behind under the old word.
    status: varchar("status", { enum: ["held", "statement_sent", "returned", "partially_returned", "withheld"] }).notNull().default("held"),
    amountReturned: numeric("amount_returned", { precision: 12, scale: 2 }),
    returnedDate: timestamp("returned_date"),
    /** The date the RA says they handed the statement over. Delivery happens
     *  outside the portal, so the date somebody recorded is the one worth
     *  keeping -- there is no send action to infer it from. */
    statementProvidedOn: timestamp("statement_provided_on"),
    /**
     * The QuickBooks or Ramp reference for the transaction that returned the
     * money. A REFERENCE ONLY -- never an account number, a routing number or
     * anything that could move money. This is what makes reconciliation
     * possible later without the portal holding a banking credential.
     */
    closeoutReference: varchar("closeout_reference"),
    /** Legacy free text from before deductions were itemised. Displayed as
     *  history and deliberately never parsed into rows: it is written by
     *  people, and a migration that guesses will be wrong in ways nobody
     *  notices until a deposit is short. */
    deductionsNotes: text("deductions_notes"),
    region: varchar("region").notNull(),
    buildingAddress: varchar("building_address").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [uniqueIndex("IDX_security_deposit_resident").on(table.residentId)],
);

export const insertSecurityDepositSchema = createInsertSchema(securityDeposits)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    amountHeld: nonNegativeAmount,
    amountReturned: nonNegativeAmount.nullish(),
    returnedDate: dateFromClient.nullish(),
    statementProvidedOn: dateFromClient.nullish(),
  });

/**
 * One deduction against one resident's deposit.
 *
 * This reverses an earlier decision, deliberately: `security_deposits` used to
 * hold deductions "as a note rather than an itemised ledger". An itemised
 * record is what any deposit statement has to be built from, so the note stays
 * as legacy history and is **never parsed into rows** — it is free text
 * written by people, and a migration that guesses would be wrong in ways
 * nobody notices until a deposit comes back short.
 *
 * A common-area charge divided across a house is stored as individual
 * per-person rows, never as a shared charge with a divisor. `splitGroupId` is
 * kept for provenance and display only: **recomputing a split later would
 * silently re-divide somebody's settled balance.**
 *
 * Finance data, and the standing rule applies without exception: descriptions,
 * amounts, dates and references only. Never an account or card number.
 */
export const depositDeductions = pgTable("deposit_deductions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  residentId: varchar("resident_id").notNull().references(() => residents.id, { onDelete: "cascade" }),
  propertyId: varchar("property_id").notNull(),
  description: varchar("description").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  /** When the damage or charge happened, which is not when it was recorded. */
  chargeDate: timestamp("charge_date").notNull(),
  // Who recorded it. The email is kept alongside the id so a deduction still
  // says who entered it after that account is gone -- this is money, and the
  // question gets asked.
  recordedByUserId: varchar("recorded_by_user_id").references(() => users.id, { onDelete: "set null" }),
  recordedByEmail: varchar("recorded_by_email"),
  // Where the charge came from, where there is something to point at. Loose
  // references rather than hard FKs, matching how rooms and assets point at
  // properties: a deduction must survive the walkthrough item being edited or
  // the request being deleted, because the money has already moved.
  walkthroughItemId: varchar("walkthrough_item_id"),
  maintenanceRequestId: varchar("maintenance_request_id"),
  /** Provenance for a split, never a basis for recomputing one. */
  splitGroupId: varchar("split_group_id"),
  region: varchar("region").notNull(),
  buildingAddress: varchar("building_address").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertDepositDeductionSchema = createInsertSchema(depositDeductions)
  .omit({
    id: true,
    // Server-owned: taken from the authenticated actor, never a request body.
    recordedByUserId: true,
    recordedByEmail: true,
    // Derived from the resident the deduction is against, so that a caller
    // cannot name a region they cannot reach and land a charge there. The
    // route resolves the resident, checks the region, and copies all three.
    propertyId: true,
    region: true,
    buildingAddress: true,
    // Set by the split route, never by a caller: a group id the client chose
    // could tie unrelated charges together in the display.
    splitGroupId: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    description: z
      .string()
      .trim()
      .min(1, "Say what the deduction is for")
      .max(300, "Keep the description under 300 characters"),
    amount: nonNegativeAmount,
    chargeDate: dateFromClient,
  });

export type DepositDeduction = typeof depositDeductions.$inferSelect;
export type InsertDepositDeduction = z.infer<typeof insertDepositDeductionSchema>;

export type SecurityDeposit = typeof securityDeposits.$inferSelect;
export type InsertSecurityDeposit = z.infer<typeof insertSecurityDepositSchema>;

// Preventive & Safety Maintenance Schedules
//
// A recurring upkeep task for a house -- a furnace serviced yearly, smoke and
// CO detectors tested twice a year, gutters cleaned before winter. `category`
// separates the two halves of the feature: "safety" tasks drive the dedicated
// safety-compliance view; "preventive" tasks are ordinary upkeep.
//
// region and buildingAddress are denormalised from the property, exactly as on
// assets and walkthrough photos, so the same region-scoped authorization
// applies without a join. When a schedule comes due a daily job turns it into
// an ordinary maintenance request; `lastGeneratedForDue` records the due date
// it last generated one for, so a schedule that stays overdue does not spawn a
// fresh request every day.
export const maintenanceSchedules = pgTable("maintenance_schedules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  propertyId: varchar("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  assetId: varchar("asset_id").references(() => assets.id, { onDelete: "set null" }),
  title: varchar("title").notNull(),
  category: varchar("category", { enum: ["safety", "preventive"] }).notNull(),
  intervalMonths: integer("interval_months").notNull(),
  lastCompletedDate: timestamp("last_completed_date"),
  nextDueDate: timestamp("next_due_date").notNull(),
  lastGeneratedForDue: timestamp("last_generated_for_due"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  region: varchar("region").notNull(),
  buildingAddress: varchar("building_address").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertMaintenanceScheduleSchema = createInsertSchema(maintenanceSchedules)
  .omit({
    id: true,
    // Server-owned: advanced by "mark done" and by the generation job, never
    // set from a request body.
    lastGeneratedForDue: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    intervalMonths: nonNegativeInt.refine((n) => n >= 1, "Must recur at least every month"),
    lastCompletedDate: dateFromClient.nullish(),
    nextDueDate: dateFromClient,
  });

export type MaintenanceSchedule = typeof maintenanceSchedules.$inferSelect;
export type InsertMaintenanceSchedule = z.infer<typeof insertMaintenanceScheduleSchema>;

// Tasks
//
// A manual to-do that lives alongside the dashboard's derived "action items"
// (unpaid rent, deposits to return, maintenance coming due -- those are computed
// from the real records and never stored here). A task is either a broadcast or
// a personal note:
//   - region set, no assignee  -> broadcast to every lead who can reach that
//     region (an admin pushing "inspect all Southwest houses" to its RAs, or an
//     RA leaving a note for their own region).
//   - region NULL, no assignee -> broadcast to everyone; only an admin may
//     create one (all-regions announcement).
//   - assignedToUserId set      -> personal ("just me"); visible only to that
//     person (and admins). v1 only ever assigns to the creator.
// region is deliberately nullable here -- the one departure from the
// "region notNull" convention -- so `canSeeTask` in server/authz.ts decides
// visibility rather than the blanket `filterByRegion`.
export const tasks = pgTable("tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: varchar("title").notNull(),
  notes: text("notes"),
  category: varchar("category", { enum: ["general", "property", "safety", "finance"] }).notNull().default("general"),
  status: varchar("status", { enum: ["open", "done"] }).notNull().default("open"),
  dueDate: timestamp("due_date"),
  region: varchar("region"),
  assignedToUserId: varchar("assigned_to_user_id").references(() => users.id, { onDelete: "set null" }),
  // Set on auto-generated recurring tasks (walkthrough / utilities reminders) to
  // keep the daily generator idempotent -- one row per cadence, region and cycle.
  // Null for hand-created tasks. Unique so a re-run never duplicates a reminder.
  sourceKey: varchar("source_key").unique(),
  // Set null rather than restrict on delete: a task (especially a broadcast)
  // can outlive its author, and deleting a user must never be blocked -- the
  // account-linking flow deletes and re-creates a user row on first sign-in.
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  completedBy: varchar("completed_by").references(() => users.id, { onDelete: "set null" }),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertTaskSchema = createInsertSchema(tasks)
  .omit({
    id: true,
    // Server-owned: taken from the authenticated actor, never a request body.
    createdBy: true,
    completedBy: true,
    completedAt: true,
    // Server-owned: only the recurring-task generator sets this.
    sourceKey: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    title: z.string().trim().min(1, "Enter a title").max(200, "Keep the title under 200 characters"),
    notes: z.string().max(2000, "Keep notes under 2000 characters").nullish(),
    dueDate: dateFromClient.nullish(),
  });

export type Task = typeof tasks.$inferSelect;
export type InsertTask = z.infer<typeof insertTaskSchema>;

// Resource hub
//
// The one page a household leader or steward needs to go to. The framing
// matters: for many students this is one of their few interactions with SPO as
// an organisation, so it should feel professional and relational.
//
// Most of the content lives on Drive. **This table stores links, never
// documents** -- duplicating a deep-clean checklist into the portal means two
// copies that disagree within a term.
export const resourceLinks = pgTable("resource_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: varchar("title").notNull(),
  url: varchar("url").notNull(),
  description: text("description"),
  // Grouping on the page. Free text rather than an enum: SPO adds categories
  // faster than anybody would ship a migration for one.
  category: varchar("category").notNull().default("General"),
  /**
   * Who sees it. Null means national -- everybody. A region name limits it to
   * the houses in that region, which is what lets one region publish its own
   * guidance without it reaching the rest.
   */
  region: varchar("region"),
  displayOrder: integer("display_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertResourceLinkSchema = createInsertSchema(resourceLinks)
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({
    title: z.string().trim().min(1, "Give the link a name").max(200),
    // Rendered into an href on a page residents read, so the scheme is checked
    // here -- see httpUrlFromClient.
    url: httpUrlFromClient.refine((value: string | null) => value !== null, "A link needs an address"),
    description: z.string().trim().max(500).nullish(),
    // The column has a default, so a caller adding a link need not order it --
    // the page groups by category and falls back to the title.
    displayOrder: nonNegativeInt.optional(),
  });

export type ResourceLink = typeof resourceLinks.$inferSelect;
export type InsertResourceLink = z.infer<typeof insertResourceLinkSchema>;

// Liability paperwork
//
// Per resident, per document: signed or not, and when. **Set by an RA, not
// e-signed** -- e-signature is a vendor integration and a separate decision,
// and pretending a checkbox is one would be worse than not having it.
export const residentDocuments = pgTable(
  "resident_documents",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    residentId: varchar("resident_id").notNull().references(() => residents.id, { onDelete: "cascade" }),
    /** Matches a key in RESIDENT_DOCUMENTS. Not an enum column: the list is
     *  code, and a database enum would need a migration for every addition. */
    documentKey: varchar("document_key").notNull(),
    /** When it was signed. Null means it has not been. */
    signedOn: timestamp("signed_on"),
    notes: text("notes"),
    recordedByUserId: varchar("recorded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    recordedByEmail: varchar("recorded_by_email"),
    region: varchar("region").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [uniqueIndex("IDX_resident_document").on(table.residentId, table.documentKey)],
);

export const insertResidentDocumentSchema = createInsertSchema(residentDocuments)
  .omit({
    id: true,
    // Server-owned: the actor comes from the session and the region from the
    // resident. "Who said this was signed" is worthless if the client says.
    recordedByUserId: true,
    recordedByEmail: true,
    region: true,
    residentId: true,
    documentKey: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    signedOn: dateFromClient.nullish(),
    notes: z.string().trim().max(500).nullish(),
  });

export type ResidentDocument = typeof residentDocuments.$inferSelect;
export type InsertResidentDocument = z.infer<typeof insertResidentDocumentSchema>;

// Startup budget
//
// One amount per property per year, plus notes. An OPERATING figure -- what
// the house has to furnish and settle itself -- and therefore not deposit or
// rent data, which is why a household leader may see their own house's without
// the finance rule being bent.
export const propertyBudgets = pgTable(
  "property_budgets",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    propertyId: varchar("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    notes: text("notes"),
    region: varchar("region").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [uniqueIndex("IDX_property_budget_year").on(table.propertyId, table.year)],
);

export const insertPropertyBudgetSchema = createInsertSchema(propertyBudgets)
  .omit({ id: true, region: true, createdAt: true, updatedAt: true })
  .extend({
    year: z.coerce.number().int().min(2000, "Use a four-digit year").max(2100),
    amount: nonNegativeAmount,
    notes: z.string().trim().max(1000).nullish(),
  });

export type PropertyBudget = typeof propertyBudgets.$inferSelect;
export type InsertPropertyBudget = z.infer<typeof insertPropertyBudgetSchema>;

// Uploaded Files
//
// One row per stored object. The stored key is random, so this is where the
// name the person chose is kept -- without it a download could only ever be
// offered as "a1b2c3....pdf".
//
// It also records who uploaded the file. A photo is uploaded before the record
// it belongs to exists, so for a short while there is nothing else to authorize
// a download against; the uploader is allowed to see their own file, and
// everyone else has to be entitled to the record that ends up referencing it.
export const uploads = pgTable("uploads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // The object key in the bucket, and the last segment of the /uploads/ URL.
  storageKey: varchar("storage_key").notNull().unique(),
  originalName: varchar("original_name").notNull(),
  contentType: varchar("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedBy: varchar("uploaded_by").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUploadSchema = createInsertSchema(uploads).omit({
  id: true,
  createdAt: true,
});

export type Upload = typeof uploads.$inferSelect;
export type InsertUpload = z.infer<typeof insertUploadSchema>;

// Audit log
//
// An append-only record of the actions that matter after the fact: who changed
// someone's access, who moved money, who took a document out of the system.
// Nothing here is used by the application at runtime -- it exists so that a
// question asked weeks later ("who deactivated this account?") has an answer.
// Routine events are retained for two years; account and permission events are
// kept indefinitely by the daily retention job in server/audit.ts.
//
// It deliberately stores no request bodies. Details are written field by field
// by the calling route, and `server/audit.ts` scrubs anything whose name looks
// like a credential before it is saved.
export const auditLog = pgTable(
  "audit_log",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    createdAt: timestamp("created_at").defaultNow(),
    // Who did it. Kept as plain columns rather than a foreign key: the record
    // must survive the deletion of the account it describes, which is exactly
    // the case where it is most likely to be needed.
    actorId: varchar("actor_id"),
    actorEmail: varchar("actor_email"),
    // What happened, as a stable dotted name, e.g. "user.role_changed".
    action: varchar("action").notNull(),
    // What it happened to.
    entityType: varchar("entity_type").notNull(),
    entityId: varchar("entity_id"),
    // One human-readable sentence, safe to show to a non-technical reader.
    summary: text("summary"),
    // Structured extras: changed field names, before/after for small scalar
    // values. Never a whole request body.
    details: jsonb("details"),
  },
  (table) => [
    index("IDX_audit_log_created_at").on(table.createdAt),
    index("IDX_audit_log_entity").on(table.entityType, table.entityId),
    index("IDX_audit_log_actor").on(table.actorId),
    // The activity page filters by action and by the actor's email address,
    // always newest-first. The table only grows, so those two filters need
    // indexes of their own -- the actor index above is on the ID, which is not
    // what anybody types into a search box.
    index("IDX_audit_log_action").on(table.action, table.createdAt),
    index("IDX_audit_log_actor_email").on(table.actorEmail),
  ],
);

export const insertAuditEventSchema = createInsertSchema(auditLog).omit({
  id: true,
  createdAt: true,
});

export type AuditEvent = typeof auditLog.$inferSelect;
export type InsertAuditEvent = z.infer<typeof insertAuditEventSchema>;

// Request Contacts (join table for linking maintenance contacts to requests)
export const requestContacts = pgTable("request_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  requestId: varchar("request_id").notNull().references(() => maintenanceRequests.id, { onDelete: "cascade" }),
  contactId: varchar("contact_id").notNull().references(() => maintenanceContacts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
});

export type RequestContact = typeof requestContacts.$inferSelect;

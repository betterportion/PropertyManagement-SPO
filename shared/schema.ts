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
  .extend({
    ageInYears: nonNegativeInt,
    purchasePrice: nonNegativeAmount.nullish(),
    lastServiced: dateFromClient.nullish(),
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
    bedrooms: nonNegativeInt.nullish(),
    bathrooms: nonNegativeAmount.nullish(),
    squareFootage: nonNegativeInt.nullish(),
    leaseStartDate: dateFromClient.nullish(),
    leaseEndDate: dateFromClient.nullish(),
    leaseRenewalDate: dateFromClient.nullish(),
  });

/**
 * The per-property setup checklist: one row per item per house.
 *
 * A dedicated table rather than a `tasks` row, settled and recorded in
 * server/propertySetup.ts. What lives here is only the state; the item list
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
    note: z.string().max(500, "Keep the note under 500 characters").nullish(),
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
    status: varchar("status", { enum: ["held", "returned", "partially_returned", "withheld"] }).notNull().default("held"),
    amountReturned: numeric("amount_returned", { precision: 12, scale: 2 }),
    returnedDate: timestamp("returned_date"),
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
  });

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

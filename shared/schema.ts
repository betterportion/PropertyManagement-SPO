import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb, index, boolean, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

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
  mondayItemId: varchar("monday_item_id"),
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
  propertyId: varchar("property_id"), // References properties table
  buildingAddress: varchar("building_address").notNull(), // Kept for backward compatibility
  requiredQuestions: text("required_questions").array(),
  displayOrder: integer("display_order").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertWalkthroughRoomSchema = createInsertSchema(walkthroughRooms).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type WalkthroughRoom = typeof walkthroughRooms.$inferSelect;
export type InsertWalkthroughRoom = z.infer<typeof insertWalkthroughRoomSchema>;

// Walkthrough Photos
export const walkthroughPhotos = pgTable("walkthrough_photos", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  roomId: varchar("room_id").notNull().references(() => walkthroughRooms.id, { onDelete: "cascade" }),
  imageUrl: varchar("image_url").notNull(),
  condition: varchar("condition", { enum: ["excellent", "good", "fair", "poor", "damaged"] }).notNull(),
  notes: text("notes"),
  region: varchar("region").notNull(),
  buildingAddress: varchar("building_address").notNull(),
  location: varchar("location").notNull(),
  questionAnswers: jsonb("question_answers"),
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
  propertyId: varchar("property_id"), // References properties table
  location: varchar("location").notNull(),
  region: varchar("region").notNull(),
  buildingAddress: varchar("building_address").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAssetSchema = createInsertSchema(assets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
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

export const insertInvoiceSchema = createInsertSchema(invoices).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Invoice = typeof invoices.$inferSelect;
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;

// Billing Records
export const billingRecords = pgTable("billing_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  residentName: varchar("resident_name").notNull(),
  unit: varchar("unit").notNull(),
  email: varchar("email").notNull(),
  phone: varchar("phone").notNull(),
  moveInDate: timestamp("move_in_date").notNull(),
  rentAmount: numeric("rent_amount", { precision: 12, scale: 2 }).notNull(),
  region: varchar("region").notNull(),
  buildingAddress: varchar("building_address").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertBillingRecordSchema = createInsertSchema(billingRecords).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
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
  propertyManager: varchar("property_manager"),
  bedrooms: integer("bedrooms"),
  bathrooms: numeric("bathrooms", { precision: 3, scale: 1 }),
  squareFootage: integer("square_footage"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertPropertySchema = createInsertSchema(properties).omit({
  id: true,
  address: true, // Computed from streetAddress, city, state, zipCode
  createdAt: true,
  updatedAt: true,
});

export type Property = typeof properties.$inferSelect;
export type InsertProperty = z.infer<typeof insertPropertySchema>;
// Type for creating/updating properties with computed address
export type InsertPropertyWithAddress = InsertProperty & { address: string };

import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb, index, boolean } from "drizzle-orm/pg-core";
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
  role: varchar("role", { enum: ["admin", "resident"] }).notNull().default("resident"),
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

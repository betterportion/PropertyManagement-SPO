import {
  users,
  userPermissions,
  type User,
  type UpsertUser,
  type UserPermissions,
  type InsertUserPermissions,
} from "@shared/schema";
import { db } from "./db";
import { eq } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;
  getAllUsers(): Promise<User[]>;
  updateUserRole(id: string, role: "admin" | "resident"): Promise<User>;
  updateUserActiveStatus(id: string, isActive: boolean): Promise<User>;
  getUserPermissions(userId: string): Promise<UserPermissions | undefined>;
  upsertUserPermissions(permissions: InsertUserPermissions): Promise<UserPermissions>;
  deleteUser(id: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(userData)
      .onConflictDoUpdate({
        target: users.id,
        set: {
          ...userData,
          updatedAt: new Date(),
        },
      })
      .returning();
    
    const existingPermissions = await this.getUserPermissions(user.id);
    if (!existingPermissions) {
      const defaultPermissions: InsertUserPermissions = {
        userId: user.id,
        canViewMaintenance: user.role === "resident",
        canManageMaintenance: user.role === "admin",
        canViewWalkthroughs: user.role === "admin",
        canManageWalkthroughs: user.role === "admin",
        canViewAssets: user.role === "admin",
        canManageAssets: user.role === "admin",
        canViewBilling: user.role === "admin",
        canManageBilling: user.role === "admin",
        canViewContacts: user.role === "admin",
        canManageContacts: user.role === "admin",
        canManageUsers: user.role === "admin",
      };
      await this.upsertUserPermissions(defaultPermissions);
    }
    
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users);
  }

  async updateUserRole(id: string, role: "admin" | "resident"): Promise<User> {
    const [user] = await db
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async updateUserActiveStatus(id: string, isActive: boolean): Promise<User> {
    const [user] = await db
      .update(users)
      .set({ isActive, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async getUserPermissions(userId: string): Promise<UserPermissions | undefined> {
    const [permissions] = await db
      .select()
      .from(userPermissions)
      .where(eq(userPermissions.userId, userId));
    return permissions;
  }

  async upsertUserPermissions(permissionsData: InsertUserPermissions): Promise<UserPermissions> {
    const [permissions] = await db
      .insert(userPermissions)
      .values(permissionsData)
      .onConflictDoUpdate({
        target: userPermissions.userId,
        set: {
          ...permissionsData,
          updatedAt: new Date(),
        },
      })
      .returning();
    return permissions;
  }

  async deleteUser(id: string): Promise<void> {
    await db.delete(users).where(eq(users.id, id));
  }
}

export const storage = new DatabaseStorage();

import {
  users,
  userPermissions,
  maintenanceRequests,
  walkthroughRooms,
  walkthroughPhotos,
  assets,
  assetPhotos,
  maintenanceContacts,
  invoices,
  billingRecords,
  properties,
  requestContacts,
  type User,
  type UpsertUser,
  type UserPermissions,
  type InsertUserPermissions,
  type MaintenanceRequest,
  type InsertMaintenanceRequest,
  type WalkthroughRoom,
  type InsertWalkthroughRoom,
  type WalkthroughPhoto,
  type InsertWalkthroughPhoto,
  type Asset,
  type InsertAsset,
  type AssetPhoto,
  type InsertAssetPhoto,
  type MaintenanceContact,
  type InsertMaintenanceContact,
  type Invoice,
  type InsertInvoice,
  type BillingRecord,
  type InsertBillingRecord,
  type Property,
  type InsertProperty,
  type InsertPropertyWithAddress,
  type RequestContact,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, desc } from "drizzle-orm";

// Helper function to filter out undefined values from partial updates
function filterUndefined<T extends Record<string, any>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, value]) => value !== undefined)
  ) as Partial<T>;
}

// Helper function to compute default permissions for a given role
const ALL_REGIONS = ["west-central", "east-central", "north-west", "south-west", "north-east", "south-east"];

function computeDefaultPermissions(userId: string, role: "admin" | "regional_administrator" | "resident"): InsertUserPermissions {
  return {
    userId,
    canViewMaintenance: true,
    canManageMaintenance: role === "admin" || role === "regional_administrator",
    canViewWalkthroughs: role !== "resident",
    canManageWalkthroughs: role === "admin" || role === "regional_administrator",
    canViewAssets: role !== "resident",
    canManageAssets: role === "admin" || role === "regional_administrator",
    canViewBilling: role !== "resident",
    canManageBilling: role === "admin",
    canViewContacts: role !== "resident",
    canManageContacts: role === "admin" || role === "regional_administrator",
    canManageUsers: role === "admin",
    canViewProperties: role !== "resident",
    canManageProperties: role === "admin" || role === "regional_administrator",
    allowedRegions: role === "admin" ? ALL_REGIONS : [],
  };
}

export interface IStorage {
  // User Management
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;
  getAllUsers(): Promise<User[]>;
  updateUserRole(id: string, role: "admin" | "regional_administrator" | "resident"): Promise<User>;
  updateUserActiveStatus(id: string, isActive: boolean): Promise<User>;
  getUserPermissions(userId: string): Promise<UserPermissions | undefined>;
  upsertUserPermissions(permissions: InsertUserPermissions): Promise<UserPermissions>;
  deleteUser(id: string): Promise<void>;

  // Maintenance Requests
  createMaintenanceRequest(request: InsertMaintenanceRequest): Promise<MaintenanceRequest>;
  getMaintenanceRequest(id: string): Promise<MaintenanceRequest | undefined>;
  getAllMaintenanceRequests(): Promise<MaintenanceRequest[]>;
  updateMaintenanceRequest(id: string, data: Partial<InsertMaintenanceRequest> & { mondayItemId?: string | null }): Promise<MaintenanceRequest>;
  deleteMaintenanceRequest(id: string): Promise<void>;

  // Walkthrough Rooms
  createWalkthroughRoom(room: InsertWalkthroughRoom): Promise<WalkthroughRoom>;
  getWalkthroughRoom(id: string): Promise<WalkthroughRoom | undefined>;
  getAllWalkthroughRooms(): Promise<WalkthroughRoom[]>;
  getWalkthroughRoomsByBuilding(buildingAddress: string): Promise<WalkthroughRoom[]>;
  updateWalkthroughRoom(id: string, data: Partial<InsertWalkthroughRoom>): Promise<WalkthroughRoom>;
  deleteWalkthroughRoom(id: string): Promise<void>;

  // Walkthrough Photos
  createWalkthroughPhoto(photo: InsertWalkthroughPhoto): Promise<WalkthroughPhoto>;
  getWalkthroughPhoto(id: string): Promise<WalkthroughPhoto | undefined>;
  getAllWalkthroughPhotos(): Promise<WalkthroughPhoto[]>;
  getWalkthroughPhotosByRoom(roomId: string): Promise<WalkthroughPhoto[]>;
  updateWalkthroughPhoto(id: string, data: Partial<InsertWalkthroughPhoto>): Promise<WalkthroughPhoto>;
  deleteWalkthroughPhoto(id: string): Promise<void>;

  // Assets
  createAsset(asset: InsertAsset): Promise<Asset>;
  getAsset(id: string): Promise<Asset | undefined>;
  getAllAssets(): Promise<Asset[]>;
  updateAsset(id: string, data: Partial<InsertAsset>): Promise<Asset>;
  deleteAsset(id: string): Promise<void>;

  // Asset Photos
  createAssetPhoto(photo: InsertAssetPhoto): Promise<AssetPhoto>;
  getAssetPhoto(id: string): Promise<AssetPhoto | undefined>;
  getAssetPhotosByAsset(assetId: string): Promise<AssetPhoto[]>;
  getAllAssetPhotos(): Promise<AssetPhoto[]>;
  deleteAssetPhoto(id: string): Promise<void>;

  // Maintenance Contacts
  createMaintenanceContact(contact: InsertMaintenanceContact): Promise<MaintenanceContact>;
  getMaintenanceContact(id: string): Promise<MaintenanceContact | undefined>;
  getAllMaintenanceContacts(): Promise<MaintenanceContact[]>;
  updateMaintenanceContact(id: string, data: Partial<InsertMaintenanceContact>): Promise<MaintenanceContact>;
  deleteMaintenanceContact(id: string): Promise<void>;

  // Invoices
  createInvoice(invoice: InsertInvoice): Promise<Invoice>;
  getInvoice(id: string): Promise<Invoice | undefined>;
  getAllInvoices(): Promise<Invoice[]>;
  updateInvoice(id: string, data: Partial<InsertInvoice>): Promise<Invoice>;
  deleteInvoice(id: string): Promise<void>;

  // Billing Records
  createBillingRecord(record: InsertBillingRecord): Promise<BillingRecord>;
  getBillingRecord(id: string): Promise<BillingRecord | undefined>;
  getAllBillingRecords(): Promise<BillingRecord[]>;
  updateBillingRecord(id: string, data: Partial<InsertBillingRecord>): Promise<BillingRecord>;
  deleteBillingRecord(id: string): Promise<void>;

  // Properties
  createProperty(property: InsertPropertyWithAddress): Promise<Property>;
  getProperty(id: string): Promise<Property | undefined>;
  getAllProperties(): Promise<Property[]>;

  // Request Contacts (linking)
  getRequestContacts(requestId: string): Promise<MaintenanceContact[]>;
  linkContactToRequest(requestId: string, contactId: string): Promise<void>;
  unlinkContactFromRequest(requestId: string, contactId: string): Promise<void>;
  updateProperty(id: string, data: Partial<InsertPropertyWithAddress>): Promise<Property>;
  deleteProperty(id: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    // Handle the case where an admin pre-created this user by email with a different ID.
    // When the user then signs in via OIDC their Replit sub differs from the stored ID,
    // causing a unique-email constraint violation. We detect this and link the accounts
    // by migrating the existing role/permissions to the new OIDC identity.
    if (userData.email && userData.id) {
      const [existingByEmail] = await db
        .select()
        .from(users)
        .where(eq(users.email, userData.email));

      if (existingByEmail && existingByEmail.id !== userData.id) {
        // Capture existing permissions before the cascade-delete
        const existingPerms = await this.getUserPermissions(existingByEmail.id);

        // Remove the old record (cascades to userPermissions)
        await db.delete(users).where(eq(users.id, existingByEmail.id));

        // Re-insert under the OIDC sub, preserving role and active status
        const [newUser] = await db
          .insert(users)
          .values({
            ...userData,
            role: existingByEmail.role,
            isActive: existingByEmail.isActive,
          })
          .returning();

        // Restore the pre-configured permissions (or create defaults)
        if (existingPerms) {
          const { id: _id, userId: _uid, createdAt: _ca, updatedAt: _ua, ...permsFields } = existingPerms;
          await this.upsertUserPermissions({ userId: newUser.id, ...permsFields });
        } else {
          await this.upsertUserPermissions(computeDefaultPermissions(newUser.id, newUser.role));
        }

        return newUser;
      }
    }

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
      const defaultPermissions = computeDefaultPermissions(user.id, user.role);
      await this.upsertUserPermissions(defaultPermissions);
    }
    
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users);
  }

  async updateUserRole(id: string, role: "admin" | "regional_administrator" | "resident"): Promise<User> {
    const [user] = await db
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    
    const existingPermissions = await this.getUserPermissions(id);
    const newDefaultPermissions = computeDefaultPermissions(id, role);
    
    await this.upsertUserPermissions({
      ...newDefaultPermissions,
      allowedRegions: role === "admin" 
        ? ALL_REGIONS 
        : (existingPermissions?.allowedRegions || []),
    });
    
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

  // Maintenance Requests Implementation
  async createMaintenanceRequest(requestData: InsertMaintenanceRequest): Promise<MaintenanceRequest> {
    const [request] = await db.insert(maintenanceRequests).values(requestData).returning();
    return request;
  }

  async getMaintenanceRequest(id: string): Promise<MaintenanceRequest | undefined> {
    const [request] = await db.select().from(maintenanceRequests).where(eq(maintenanceRequests.id, id));
    return request;
  }

  async getAllMaintenanceRequests(): Promise<MaintenanceRequest[]> {
    return await db.select().from(maintenanceRequests).orderBy(desc(maintenanceRequests.submittedDate));
  }

  async updateMaintenanceRequest(id: string, data: Partial<InsertMaintenanceRequest> & { mondayItemId?: string | null }): Promise<MaintenanceRequest> {
    const [request] = await db
      .update(maintenanceRequests)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(maintenanceRequests.id, id))
      .returning();
    return request;
  }

  async deleteMaintenanceRequest(id: string): Promise<void> {
    await db.delete(maintenanceRequests).where(eq(maintenanceRequests.id, id));
  }

  // Walkthrough Rooms Implementation
  async createWalkthroughRoom(roomData: InsertWalkthroughRoom): Promise<WalkthroughRoom> {
    const [room] = await db.insert(walkthroughRooms).values(roomData).returning();
    return room;
  }

  async getWalkthroughRoom(id: string): Promise<WalkthroughRoom | undefined> {
    const [room] = await db.select().from(walkthroughRooms).where(eq(walkthroughRooms.id, id));
    return room;
  }

  async getAllWalkthroughRooms(): Promise<WalkthroughRoom[]> {
    return await db.select().from(walkthroughRooms).orderBy(walkthroughRooms.displayOrder);
  }

  async getWalkthroughRoomsByBuilding(buildingAddress: string): Promise<WalkthroughRoom[]> {
    return await db
      .select()
      .from(walkthroughRooms)
      .where(eq(walkthroughRooms.buildingAddress, buildingAddress))
      .orderBy(walkthroughRooms.displayOrder);
  }

  async updateWalkthroughRoom(id: string, data: Partial<InsertWalkthroughRoom>): Promise<WalkthroughRoom> {
    const [room] = await db
      .update(walkthroughRooms)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(walkthroughRooms.id, id))
      .returning();
    return room;
  }

  async deleteWalkthroughRoom(id: string): Promise<void> {
    await db.delete(walkthroughRooms).where(eq(walkthroughRooms.id, id));
  }

  // Walkthrough Photos Implementation
  async createWalkthroughPhoto(photoData: InsertWalkthroughPhoto): Promise<WalkthroughPhoto> {
    const [photo] = await db.insert(walkthroughPhotos).values(photoData).returning();
    return photo;
  }

  async getWalkthroughPhoto(id: string): Promise<WalkthroughPhoto | undefined> {
    const [photo] = await db.select().from(walkthroughPhotos).where(eq(walkthroughPhotos.id, id));
    return photo;
  }

  async getAllWalkthroughPhotos(): Promise<WalkthroughPhoto[]> {
    return await db.select().from(walkthroughPhotos).orderBy(desc(walkthroughPhotos.uploadedDate));
  }

  async getWalkthroughPhotosByRoom(roomId: string): Promise<WalkthroughPhoto[]> {
    return await db
      .select()
      .from(walkthroughPhotos)
      .where(eq(walkthroughPhotos.roomId, roomId))
      .orderBy(desc(walkthroughPhotos.uploadedDate));
  }

  async updateWalkthroughPhoto(id: string, data: Partial<InsertWalkthroughPhoto>): Promise<WalkthroughPhoto> {
    const [photo] = await db
      .update(walkthroughPhotos)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(walkthroughPhotos.id, id))
      .returning();
    return photo;
  }

  async deleteWalkthroughPhoto(id: string): Promise<void> {
    await db.delete(walkthroughPhotos).where(eq(walkthroughPhotos.id, id));
  }

  // Assets Implementation
  async createAsset(assetData: InsertAsset): Promise<Asset> {
    const [asset] = await db.insert(assets).values(assetData).returning();
    return asset;
  }

  async getAsset(id: string): Promise<Asset | undefined> {
    const [asset] = await db.select().from(assets).where(eq(assets.id, id));
    return asset;
  }

  async getAllAssets(): Promise<Asset[]> {
    return await db.select().from(assets);
  }

  async updateAsset(id: string, data: Partial<InsertAsset>): Promise<Asset> {
    const [asset] = await db
      .update(assets)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(assets.id, id))
      .returning();
    return asset;
  }

  async deleteAsset(id: string): Promise<void> {
    await db.delete(assets).where(eq(assets.id, id));
  }

  // Asset Photos Implementation
  async createAssetPhoto(photoData: InsertAssetPhoto): Promise<AssetPhoto> {
    const [photo] = await db.insert(assetPhotos).values(photoData).returning();
    return photo;
  }

  async getAssetPhoto(id: string): Promise<AssetPhoto | undefined> {
    const [photo] = await db.select().from(assetPhotos).where(eq(assetPhotos.id, id));
    return photo;
  }

  async getAssetPhotosByAsset(assetId: string): Promise<AssetPhoto[]> {
    return await db
      .select()
      .from(assetPhotos)
      .where(eq(assetPhotos.assetId, assetId))
      .orderBy(desc(assetPhotos.uploadedDate));
  }

  async getAllAssetPhotos(): Promise<AssetPhoto[]> {
    return await db.select().from(assetPhotos).orderBy(desc(assetPhotos.uploadedDate));
  }

  async deleteAssetPhoto(id: string): Promise<void> {
    await db.delete(assetPhotos).where(eq(assetPhotos.id, id));
  }

  // Maintenance Contacts Implementation
  async createMaintenanceContact(contactData: InsertMaintenanceContact): Promise<MaintenanceContact> {
    const [contact] = await db.insert(maintenanceContacts).values(contactData).returning();
    return contact;
  }

  async getMaintenanceContact(id: string): Promise<MaintenanceContact | undefined> {
    const [contact] = await db.select().from(maintenanceContacts).where(eq(maintenanceContacts.id, id));
    return contact;
  }

  async getAllMaintenanceContacts(): Promise<MaintenanceContact[]> {
    return await db.select().from(maintenanceContacts);
  }

  async updateMaintenanceContact(id: string, data: Partial<InsertMaintenanceContact>): Promise<MaintenanceContact> {
    const [contact] = await db
      .update(maintenanceContacts)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(maintenanceContacts.id, id))
      .returning();
    return contact;
  }

  async deleteMaintenanceContact(id: string): Promise<void> {
    await db.delete(maintenanceContacts).where(eq(maintenanceContacts.id, id));
  }

  // Invoices Implementation
  async createInvoice(invoiceData: InsertInvoice): Promise<Invoice> {
    const [invoice] = await db.insert(invoices).values(invoiceData).returning();
    return invoice;
  }

  async getInvoice(id: string): Promise<Invoice | undefined> {
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, id));
    return invoice;
  }

  async getAllInvoices(): Promise<Invoice[]> {
    return await db.select().from(invoices).orderBy(desc(invoices.dueDate));
  }

  async updateInvoice(id: string, data: Partial<InsertInvoice>): Promise<Invoice> {
    const [invoice] = await db
      .update(invoices)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(invoices.id, id))
      .returning();
    return invoice;
  }

  async deleteInvoice(id: string): Promise<void> {
    await db.delete(invoices).where(eq(invoices.id, id));
  }

  // Billing Records Implementation
  async createBillingRecord(recordData: InsertBillingRecord): Promise<BillingRecord> {
    const [record] = await db.insert(billingRecords).values(recordData).returning();
    return record;
  }

  async getBillingRecord(id: string): Promise<BillingRecord | undefined> {
    const [record] = await db.select().from(billingRecords).where(eq(billingRecords.id, id));
    return record;
  }

  async getAllBillingRecords(): Promise<BillingRecord[]> {
    return await db.select().from(billingRecords);
  }

  async updateBillingRecord(id: string, data: Partial<InsertBillingRecord>): Promise<BillingRecord> {
    const [record] = await db
      .update(billingRecords)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(billingRecords.id, id))
      .returning();
    return record;
  }

  async deleteBillingRecord(id: string): Promise<void> {
    await db.delete(billingRecords).where(eq(billingRecords.id, id));
  }

  // Properties Implementation
  async createProperty(propertyData: InsertPropertyWithAddress): Promise<Property> {
    const [property] = await db.insert(properties).values(propertyData).returning();
    return property;
  }

  async getProperty(id: string): Promise<Property | undefined> {
    const [property] = await db.select().from(properties).where(eq(properties.id, id));
    return property;
  }

  async getAllProperties(): Promise<Property[]> {
    return await db.select().from(properties);
  }

  async updateProperty(id: string, data: Partial<InsertPropertyWithAddress>): Promise<Property> {
    const [property] = await db
      .update(properties)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(properties.id, id))
      .returning();
    return property;
  }

  async deleteProperty(id: string): Promise<void> {
    await db.delete(properties).where(eq(properties.id, id));
  }

  async getRequestContacts(requestId: string): Promise<MaintenanceContact[]> {
    const rows = await db
      .select({ contact: maintenanceContacts })
      .from(requestContacts)
      .innerJoin(maintenanceContacts, eq(requestContacts.contactId, maintenanceContacts.id))
      .where(eq(requestContacts.requestId, requestId));
    return rows.map(r => r.contact);
  }

  async linkContactToRequest(requestId: string, contactId: string): Promise<void> {
    const existing = await db
      .select()
      .from(requestContacts)
      .where(and(eq(requestContacts.requestId, requestId), eq(requestContacts.contactId, contactId)));
    if (existing.length === 0) {
      await db.insert(requestContacts).values({ requestId, contactId });
    }
  }

  async unlinkContactFromRequest(requestId: string, contactId: string): Promise<void> {
    await db
      .delete(requestContacts)
      .where(and(eq(requestContacts.requestId, requestId), eq(requestContacts.contactId, contactId)));
  }
}

export const storage = new DatabaseStorage();

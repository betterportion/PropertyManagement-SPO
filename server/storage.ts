import {
  users,
  userPermissions,
  maintenanceRequests,
  maintenanceRequestPhotos,
  walkthroughRooms,
  walkthroughs,
  walkthroughItems,
  walkthroughTemplateRooms,
  walkthroughTemplateItems,
  walkthroughPhotos,
  assets,
  assetPhotos,
  maintenanceContacts,
  contactNotes,
  invoices,
  billingRecords,
  properties,
  propertySetupItems,
  residents,
  rentPayments,
  securityDeposits,
  maintenanceSchedules,
  tasks,
  requestContacts,
  type User,
  type UpsertUser,
  type UserPermissions,
  type InsertUserPermissions,
  type MaintenanceRequest,
  type InsertMaintenanceRequest,
  type MaintenanceRequestPhoto,
  type InsertMaintenanceRequestPhoto,
  type WalkthroughRoom,
  type Walkthrough,
  type InsertWalkthrough,
  type WalkthroughItem,
  type InsertWalkthroughItem,
  type FlaggedWalkthroughItem,
  WALKTHROUGH_FLAGGED_CONDITIONS,
  type WalkthroughTemplateRoom,
  type InsertWalkthroughTemplateRoom,
  type WalkthroughTemplateItem,
  type InsertWalkthroughTemplateItem,
  type InsertWalkthroughRoom,
  type WalkthroughPhoto,
  type InsertWalkthroughPhoto,
  type Asset,
  type InsertAsset,
  type AssetPhoto,
  type InsertAssetPhoto,
  type MaintenanceContact,
  type InsertMaintenanceContact,
  type ContactNote,
  type InsertContactNote,
  type Invoice,
  type InsertInvoice,
  type BillingRecord,
  type InsertBillingRecord,
  type Property,
  type InsertPropertyWithAddress,
  type PropertySetupItem,
  type InsertPropertySetupItem,
  type MaintenanceSchedule,
  type InsertMaintenanceSchedule,
  type Resident,
  type InsertResident,
  type RentPayment,
  type InsertRentPayment,
  type SecurityDeposit,
  type InsertSecurityDeposit,
  type Task,
  type InsertTask,
  uploads,
  type Upload,
  type InsertUpload,
  auditLog,
  type AuditEvent,
  type InsertAuditEvent,
} from "@shared/schema";
import { db } from "./db";
import { REGIONS } from "@shared/regions";
import { eq, and, or, desc, asc, inArray, lt, lte, gte, ilike, count, notInArray, sql } from "drizzle-orm";

// Helper function to filter out undefined values from partial updates
function filterUndefined<T extends Record<string, any>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, value]) => value !== undefined)
  ) as Partial<T>;
}

// Helper function to compute default permissions for a given role. An admin can
// reach every region; the canonical list is the single source of truth in
// shared/regions.ts, so this never drifts from the region names on records.
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
    // Staff get both finance flags by default: today's finance audience is
    // exactly the leads, and the flags exist so that stops being true later
    // by revoking a grant, not by rewriting guards.
    canViewFinancials: role !== "resident",
    canManageFinancials: role !== "resident",
    // Both new-surface flags start false for every role, including staff. They
    // gate features that do not exist yet, and the plan they come from asks for
    // them to land ahead of the features rather than alongside them -- so the
    // safe starting state is nobody, and turning one on is a data change.
    canCompleteWalkthroughs: false,
    canManagePropertySetup: false,
    allowedRegions: role === "admin" ? [...REGIONS] : [],
  };
}

export interface IStorage {
  // User Management
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;
  getAllUsers(): Promise<User[]>;
  updateUserRole(id: string, role: "admin" | "regional_administrator" | "resident"): Promise<User>;
  updateUserActiveStatus(id: string, isActive: boolean): Promise<User>;
  updateUserProperty(id: string, propertyId: string | null): Promise<User>;
  getActiveResidentAccountByEmail(email: string): Promise<User | undefined>;
  getUserPermissions(userId: string): Promise<UserPermissions | undefined>;
  getAllUserPermissions(): Promise<UserPermissions[]>;
  upsertUserPermissions(permissions: InsertUserPermissions): Promise<UserPermissions>;
  deleteUser(id: string): Promise<void>;

  // Maintenance Requests
  createMaintenanceRequest(
    request: InsertMaintenanceRequest & { completedDate?: Date | null },
  ): Promise<MaintenanceRequest>;
  getMaintenanceRequest(id: string): Promise<MaintenanceRequest | undefined>;
  getAllMaintenanceRequests(): Promise<MaintenanceRequest[]>;
  // completedDate is not part of the insert schema -- it is set by the server
  // from a status transition, never accepted from a request body. See
  // server/maintenanceStatus.ts. null clears it when a request reopens.
  updateMaintenanceRequest(
    id: string,
    data: Partial<InsertMaintenanceRequest> & { completedDate?: Date | null },
  ): Promise<MaintenanceRequest>;
  deleteMaintenanceRequest(id: string): Promise<void>;

  // Maintenance Request Photos
  createMaintenanceRequestPhoto(photo: InsertMaintenanceRequestPhoto & { uploadedBy: string }): Promise<MaintenanceRequestPhoto>;
  getMaintenanceRequestPhoto(id: string): Promise<MaintenanceRequestPhoto | undefined>;
  getMaintenanceRequestPhotosByRequest(requestId: string): Promise<MaintenanceRequestPhoto[]>;
  getAllMaintenanceRequestPhotos(): Promise<MaintenanceRequestPhoto[]>;
  deleteMaintenanceRequestPhoto(id: string): Promise<void>;

  // Walkthrough template (national)
  getAllWalkthroughTemplateRooms(): Promise<WalkthroughTemplateRoom[]>;
  getWalkthroughTemplateRoom(id: string): Promise<WalkthroughTemplateRoom | undefined>;
  createWalkthroughTemplateRoom(room: InsertWalkthroughTemplateRoom): Promise<WalkthroughTemplateRoom>;
  updateWalkthroughTemplateRoom(id: string, data: Partial<InsertWalkthroughTemplateRoom>): Promise<WalkthroughTemplateRoom>;
  deleteWalkthroughTemplateRoom(id: string): Promise<void>;
  getAllWalkthroughTemplateItems(): Promise<WalkthroughTemplateItem[]>;
  getWalkthroughTemplateItem(id: string): Promise<WalkthroughTemplateItem | undefined>;
  createWalkthroughTemplateItem(item: InsertWalkthroughTemplateItem): Promise<WalkthroughTemplateItem>;
  updateWalkthroughTemplateItem(id: string, data: Partial<InsertWalkthroughTemplateItem>): Promise<WalkthroughTemplateItem>;
  deleteWalkthroughTemplateItem(id: string): Promise<void>;

  // Walkthroughs
  createWalkthrough(walkthrough: InsertWalkthrough): Promise<Walkthrough>;
  getWalkthrough(id: string): Promise<Walkthrough | undefined>;
  getAllWalkthroughs(): Promise<Walkthrough[]>;
  getWalkthroughsByProperty(propertyId: string): Promise<Walkthrough[]>;
  updateWalkthrough(id: string, data: Partial<InsertWalkthrough>): Promise<Walkthrough>;
  deleteWalkthrough(id: string): Promise<void>;

  // Walkthrough Items
  createWalkthroughItem(item: InsertWalkthroughItem): Promise<WalkthroughItem>;
  getWalkthroughItem(id: string): Promise<WalkthroughItem | undefined>;
  getAllWalkthroughItems(): Promise<WalkthroughItem[]>;
  getWalkthroughItemsByRoom(roomId: string): Promise<WalkthroughItem[]>;
  getWalkthroughItemsByWalkthrough(walkthroughId: string): Promise<WalkthroughItem[]>;
  /** Every item recorded poor or damaged, newest walkthrough first. */
  getFlaggedWalkthroughItems(): Promise<FlaggedWalkthroughItem[]>;
  updateWalkthroughItem(id: string, data: Partial<InsertWalkthroughItem>): Promise<WalkthroughItem>;
  deleteWalkthroughItem(id: string): Promise<void>;

  // Walkthrough Rooms
  getWalkthroughRoomsByWalkthrough(walkthroughId: string): Promise<WalkthroughRoom[]>;
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
  // The snooze attribution is not part of the insert schema -- it is taken
  // from the authenticated actor and the clock, never from a request body,
  // exactly as completedDate is on a maintenance request. See the snooze
  // routes in server/routes.ts.
  updateAsset(
    id: string,
    data: Partial<InsertAsset> & {
      snoozedByUserId?: string | null;
      snoozedAt?: Date | null;
      snoozedUntil?: Date | null;
    },
  ): Promise<Asset>;
  deleteAsset(id: string): Promise<void>;

  // Asset Photos
  createAssetPhoto(photo: InsertAssetPhoto): Promise<AssetPhoto>;
  getAssetPhoto(id: string): Promise<AssetPhoto | undefined>;
  getAssetPhotosByAsset(assetId: string): Promise<AssetPhoto[]>;
  getAllAssetPhotos(): Promise<AssetPhoto[]>;
  deleteAssetPhoto(id: string): Promise<void>;

  // Maintenance Schedules
  createMaintenanceSchedule(schedule: InsertMaintenanceSchedule): Promise<MaintenanceSchedule>;
  getMaintenanceSchedule(id: string): Promise<MaintenanceSchedule | undefined>;
  getAllMaintenanceSchedules(): Promise<MaintenanceSchedule[]>;
  getMaintenanceSchedulesByProperty(propertyId: string): Promise<MaintenanceSchedule[]>;
  updateMaintenanceSchedule(id: string, data: Partial<InsertMaintenanceSchedule>): Promise<MaintenanceSchedule>;
  deleteMaintenanceSchedule(id: string): Promise<void>;
  /** Active schedules whose next-due date is on or before `asOf`. */
  getDueMaintenanceSchedules(asOf: Date): Promise<MaintenanceSchedule[]>;
  /** Records that a request has been generated for the given due date. */
  markMaintenanceScheduleGenerated(id: string, dueDate: Date): Promise<void>;
  /** Marks a schedule done: sets the completed date, the new next-due date, and
   *  clears the generation marker so the next cycle can generate again. */
  completeMaintenanceSchedule(id: string, completedDate: Date, nextDueDate: Date): Promise<MaintenanceSchedule>;

  // Residents
  createResident(resident: InsertResident): Promise<Resident>;
  getResident(id: string): Promise<Resident | undefined>;
  getAllResidents(): Promise<Resident[]>;
  getResidentsByProperty(propertyId: string): Promise<Resident[]>;
  getActiveResidentByEmail(email: string): Promise<Resident | undefined>;
  updateResident(id: string, data: Partial<InsertResident>): Promise<Resident>;
  deleteResident(id: string): Promise<void>;

  // Rent Payments
  createRentPayment(payment: InsertRentPayment): Promise<RentPayment>;
  getRentPayment(id: string): Promise<RentPayment | undefined>;
  getAllRentPayments(): Promise<RentPayment[]>;
  getRentPaymentsByProperty(propertyId: string): Promise<RentPayment[]>;
  /** The payment a resident already has for a month, if any. */
  getRentPaymentForResidentPeriod(residentId: string, period: string): Promise<RentPayment | undefined>;
  /** The most recent amount charged for a house, used to default the next month. */
  getLatestRentAmountForProperty(propertyId: string): Promise<string | undefined>;
  updateRentPayment(id: string, data: Partial<InsertRentPayment>): Promise<RentPayment>;
  deleteRentPayment(id: string): Promise<void>;

  // Security Deposits
  createSecurityDeposit(deposit: InsertSecurityDeposit): Promise<SecurityDeposit>;
  getSecurityDeposit(id: string): Promise<SecurityDeposit | undefined>;
  getAllSecurityDeposits(): Promise<SecurityDeposit[]>;
  getSecurityDepositByResident(residentId: string): Promise<SecurityDeposit | undefined>;
  updateSecurityDeposit(id: string, data: Partial<InsertSecurityDeposit>): Promise<SecurityDeposit>;
  deleteSecurityDeposit(id: string): Promise<void>;

  // Tasks
  createTask(task: InsertTask & { createdBy: string | null; sourceKey?: string | null }): Promise<Task>;
  getTask(id: string): Promise<Task | undefined>;
  getTaskBySourceKey(sourceKey: string): Promise<Task | undefined>;
  getAllTasks(): Promise<Task[]>;
  updateTask(id: string, data: Partial<Task>): Promise<Task>;
  deleteTask(id: string): Promise<void>;

  // Maintenance Contacts
  createMaintenanceContact(contact: InsertMaintenanceContact): Promise<MaintenanceContact>;
  getMaintenanceContact(id: string): Promise<MaintenanceContact | undefined>;
  getAllMaintenanceContacts(): Promise<MaintenanceContact[]>;
  updateMaintenanceContact(id: string, data: Partial<InsertMaintenanceContact>): Promise<MaintenanceContact>;
  deleteMaintenanceContact(id: string): Promise<void>;

  // Contractor history
  /** Every maintenance request this vendor was linked to, newest first. */
  getRequestsForContact(contactId: string): Promise<MaintenanceRequest[]>;
  getContactNotes(contactId: string): Promise<ContactNote[]>;
  getContactNote(id: string): Promise<ContactNote | undefined>;
  createContactNote(
    note: InsertContactNote & { contactId: string; authorUserId: string | null; authorEmail: string | null; region: string },
  ): Promise<ContactNote>;
  deleteContactNote(id: string): Promise<void>;

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

  // Property setup checklist
  getPropertySetupItems(propertyId: string): Promise<PropertySetupItem[]>;
  getAllPropertySetupItems(): Promise<PropertySetupItem[]>;
  /** Seeds a new house's checklist. Ignores rows that already exist. */
  createPropertySetupItems(rows: InsertPropertySetupItem[]): Promise<PropertySetupItem[]>;
  /** Sets one item's state, creating the row if the house predates it. */
  setPropertySetupItem(
    propertyId: string,
    itemKey: string,
    patch: { status: PropertySetupItem["status"]; note?: string | null; region: string; setByUserId: string | null; setAt: Date },
  ): Promise<PropertySetupItem>;

  // Request Contacts (linking)
  getRequestContacts(requestId: string): Promise<MaintenanceContact[]>;
  linkContactToRequest(requestId: string, contactId: string): Promise<void>;
  unlinkContactFromRequest(requestId: string, contactId: string): Promise<void>;
  updateProperty(id: string, data: Partial<InsertPropertyWithAddress>): Promise<Property>;
  deleteProperty(id: string): Promise<void>;

  // Audit log
  createAuditEvent(event: InsertAuditEvent): Promise<AuditEvent>;
  /** One page of activity, newest first, plus the total the filters match. */
  listAuditEvents(query: AuditEventQuery): Promise<AuditEventPage>;
  /** Deletes at most one bounded batch of expired, non-protected events. */
  deleteExpiredAuditEvents(
    before: Date,
    protectedActions: readonly string[],
    batchSize: number,
  ): Promise<number>;

  // Uploaded Files
  createUpload(upload: InsertUpload): Promise<Upload>;
  getUploadByStorageKey(storageKey: string): Promise<Upload | undefined>;
  findUploadReferences(url: string): Promise<UploadReference[]>;
}

/**
 * A record that points at an uploaded file. Downloads are authorized against
 * these: whoever may read the record may read the file it displays.
 *
 * There is no column linking a file back to its record, because a photo is
 * uploaded before the record that will show it exists. The link only exists in
 * the direction the application writes it -- record to URL -- so this searches
 * that way round.
 */
/**
 * Which slice of the activity trail to read.
 *
 * `limit` and `offset` are required rather than optional: the table grows
 * without bound and there is no caller that wants all of it. `to` is exclusive,
 * so a caller asking for a whole day passes the following midnight and does not
 * have to reason about how precise a timestamp is.
 */
export interface AuditEventQuery {
  /** Partial, case-insensitive match against the stored actor email. */
  actorEmail?: string;
  action?: string;
  /** Inclusive lower bound on when the event happened. */
  from?: Date;
  /** Exclusive upper bound on when the event happened. */
  to?: Date;
  limit: number;
  offset: number;
}

export interface AuditEventPage {
  events: AuditEvent[];
  /** How many rows the filters match in total, for the page count. */
  total: number;
}

export type UploadReference =
  | { kind: "maintenanceRequest"; record: MaintenanceRequest }
  | { kind: "maintenanceRequestPhoto"; record: MaintenanceRequestPhoto }
  | { kind: "walkthroughPhoto"; record: WalkthroughPhoto }
  | { kind: "assetPhoto"; record: AssetPhoto }
  | { kind: "billingRecord"; record: BillingRecord }
  | { kind: "property"; record: Property };

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

        // Re-insert under the OIDC sub, preserving role, active status and the
        // property link (a pre-created resident account already points at its
        // house; the sign-in claims never carry propertyId).
        const [newUser] = await db
          .insert(users)
          .values({
            ...userData,
            role: existingByEmail.role,
            isActive: existingByEmail.isActive,
            propertyId: userData.propertyId ?? existingByEmail.propertyId,
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

  async getActiveResidentAccountByEmail(email: string): Promise<User | undefined> {
    // Case-insensitive like the roster lookup: the roster email is typed by
    // staff, the login email comes from the identity provider, and the two
    // can disagree on case. Restricted to active resident-role accounts
    // because that is the only kind of login a roster row can speak for.
    const [user] = await db
      .select()
      .from(users)
      .where(and(ilike(users.email, email), eq(users.role, "resident"), eq(users.isActive, true)))
      .limit(1);
    return user;
  }

  async updateUserProperty(id: string, propertyId: string | null): Promise<User> {
    const [user] = await db
      .update(users)
      .set({ propertyId, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user;
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
        ? [...REGIONS]
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

  async getAllUserPermissions(): Promise<UserPermissions[]> {
    return await db.select().from(userPermissions);
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
  async createMaintenanceRequest(
    requestData: InsertMaintenanceRequest & { completedDate?: Date | null },
  ): Promise<MaintenanceRequest> {
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

  async updateMaintenanceRequest(
    id: string,
    data: Partial<InsertMaintenanceRequest> & { completedDate?: Date | null },
  ): Promise<MaintenanceRequest> {
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

  // Maintenance Request Photos Implementation
  async createMaintenanceRequestPhoto(photoData: InsertMaintenanceRequestPhoto & { uploadedBy: string }): Promise<MaintenanceRequestPhoto> {
    const [photo] = await db.insert(maintenanceRequestPhotos).values(photoData).returning();
    return photo;
  }

  async getMaintenanceRequestPhoto(id: string): Promise<MaintenanceRequestPhoto | undefined> {
    const [photo] = await db.select().from(maintenanceRequestPhotos).where(eq(maintenanceRequestPhotos.id, id));
    return photo;
  }

  async getMaintenanceRequestPhotosByRequest(requestId: string): Promise<MaintenanceRequestPhoto[]> {
    return await db
      .select()
      .from(maintenanceRequestPhotos)
      .where(eq(maintenanceRequestPhotos.requestId, requestId))
      .orderBy(desc(maintenanceRequestPhotos.uploadedDate));
  }

  async getAllMaintenanceRequestPhotos(): Promise<MaintenanceRequestPhoto[]> {
    return await db.select().from(maintenanceRequestPhotos).orderBy(desc(maintenanceRequestPhotos.uploadedDate));
  }

  async deleteMaintenanceRequestPhoto(id: string): Promise<void> {
    await db.delete(maintenanceRequestPhotos).where(eq(maintenanceRequestPhotos.id, id));
  }

  // Walkthrough template Implementation
  async getAllWalkthroughTemplateRooms(): Promise<WalkthroughTemplateRoom[]> {
    return await db.select().from(walkthroughTemplateRooms).orderBy(walkthroughTemplateRooms.displayOrder);
  }

  async getWalkthroughTemplateRoom(id: string): Promise<WalkthroughTemplateRoom | undefined> {
    const [row] = await db.select().from(walkthroughTemplateRooms).where(eq(walkthroughTemplateRooms.id, id));
    return row;
  }

  async createWalkthroughTemplateRoom(data: InsertWalkthroughTemplateRoom): Promise<WalkthroughTemplateRoom> {
    const [row] = await db.insert(walkthroughTemplateRooms).values(data).returning();
    return row;
  }

  async updateWalkthroughTemplateRoom(id: string, data: Partial<InsertWalkthroughTemplateRoom>): Promise<WalkthroughTemplateRoom> {
    const [row] = await db
      .update(walkthroughTemplateRooms)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(walkthroughTemplateRooms.id, id))
      .returning();
    return row;
  }

  async deleteWalkthroughTemplateRoom(id: string): Promise<void> {
    await db.delete(walkthroughTemplateRooms).where(eq(walkthroughTemplateRooms.id, id));
  }

  async getAllWalkthroughTemplateItems(): Promise<WalkthroughTemplateItem[]> {
    return await db.select().from(walkthroughTemplateItems).orderBy(walkthroughTemplateItems.displayOrder);
  }

  async getWalkthroughTemplateItem(id: string): Promise<WalkthroughTemplateItem | undefined> {
    const [row] = await db.select().from(walkthroughTemplateItems).where(eq(walkthroughTemplateItems.id, id));
    return row;
  }

  async createWalkthroughTemplateItem(data: InsertWalkthroughTemplateItem): Promise<WalkthroughTemplateItem> {
    const [row] = await db.insert(walkthroughTemplateItems).values(data).returning();
    return row;
  }

  async updateWalkthroughTemplateItem(id: string, data: Partial<InsertWalkthroughTemplateItem>): Promise<WalkthroughTemplateItem> {
    const [row] = await db
      .update(walkthroughTemplateItems)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(walkthroughTemplateItems.id, id))
      .returning();
    return row;
  }

  async deleteWalkthroughTemplateItem(id: string): Promise<void> {
    await db.delete(walkthroughTemplateItems).where(eq(walkthroughTemplateItems.id, id));
  }

  // Walkthroughs Implementation
  async createWalkthrough(data: InsertWalkthrough): Promise<Walkthrough> {
    const [row] = await db.insert(walkthroughs).values(data).returning();
    return row;
  }

  async getWalkthrough(id: string): Promise<Walkthrough | undefined> {
    const [row] = await db.select().from(walkthroughs).where(eq(walkthroughs.id, id));
    return row;
  }

  async getAllWalkthroughs(): Promise<Walkthrough[]> {
    return await db.select().from(walkthroughs).orderBy(desc(walkthroughs.walkthroughDate));
  }

  async getWalkthroughsByProperty(propertyId: string): Promise<Walkthrough[]> {
    return await db
      .select()
      .from(walkthroughs)
      .where(eq(walkthroughs.propertyId, propertyId))
      .orderBy(desc(walkthroughs.walkthroughDate));
  }

  async updateWalkthrough(id: string, data: Partial<InsertWalkthrough>): Promise<Walkthrough> {
    const [row] = await db
      .update(walkthroughs)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(walkthroughs.id, id))
      .returning();
    return row;
  }

  async deleteWalkthrough(id: string): Promise<void> {
    await db.delete(walkthroughs).where(eq(walkthroughs.id, id));
  }

  // Walkthrough Items Implementation
  async createWalkthroughItem(data: InsertWalkthroughItem): Promise<WalkthroughItem> {
    const [row] = await db.insert(walkthroughItems).values(data).returning();
    return row;
  }

  async getWalkthroughItem(id: string): Promise<WalkthroughItem | undefined> {
    const [row] = await db.select().from(walkthroughItems).where(eq(walkthroughItems.id, id));
    return row;
  }

  async getAllWalkthroughItems(): Promise<WalkthroughItem[]> {
    return await db.select().from(walkthroughItems).orderBy(walkthroughItems.displayOrder);
  }

  async getWalkthroughItemsByRoom(roomId: string): Promise<WalkthroughItem[]> {
    return await db
      .select()
      .from(walkthroughItems)
      .where(eq(walkthroughItems.roomId, roomId))
      .orderBy(walkthroughItems.displayOrder);
  }

  /**
   * Every item in a walkthrough, across all of its rooms.
   *
   * One query rather than one per room: the mobile screen needs the whole
   * checklist to show progress before the RA has opened a single room, and a
   * phone in a house should not make eight round trips to find that out.
   */
  async getWalkthroughItemsByWalkthrough(walkthroughId: string): Promise<WalkthroughItem[]> {
    const rows = await db
      .select({ item: walkthroughItems })
      .from(walkthroughItems)
      .innerJoin(walkthroughRooms, eq(walkthroughItems.roomId, walkthroughRooms.id))
      .where(eq(walkthroughRooms.walkthroughId, walkthroughId))
      .orderBy(walkthroughRooms.displayOrder, walkthroughItems.displayOrder);
    return rows.map((row) => row.item);
  }

  /**
   * Every checklist item across every walkthrough whose condition needs
   * attention.
   *
   * One query for the whole list, joined up to the walkthrough so each row can
   * name its house: the caller filters by region against `region` on the
   * walkthrough itself, exactly as it would over `getAllWalkthroughs`, without
   * a per-row lookup to find out where an item lives.
   *
   * The photo count is a correlated subquery rather than a join, so a room
   * with three photos still produces one row per item rather than three.
   */
  async getFlaggedWalkthroughItems(): Promise<FlaggedWalkthroughItem[]> {
    const photoCount = db
      .select({ value: count() })
      .from(walkthroughPhotos)
      .where(eq(walkthroughPhotos.roomId, walkthroughRooms.id));

    const rows = await db
      .select({
        itemId: walkthroughItems.id,
        label: walkthroughItems.label,
        condition: walkthroughItems.condition,
        notes: walkthroughItems.notes,
        roomId: walkthroughRooms.id,
        roomName: walkthroughRooms.name,
        walkthroughId: walkthroughs.id,
        walkthroughDate: walkthroughs.walkthroughDate,
        walkthroughType: walkthroughs.type,
        walkthroughStatus: walkthroughs.status,
        propertyId: walkthroughs.propertyId,
        buildingAddress: walkthroughs.buildingAddress,
        region: walkthroughs.region,
        roomPhotoCount: sql<number>`(${photoCount})`.mapWith(Number),
      })
      .from(walkthroughItems)
      .innerJoin(walkthroughRooms, eq(walkthroughItems.roomId, walkthroughRooms.id))
      .innerJoin(walkthroughs, eq(walkthroughRooms.walkthroughId, walkthroughs.id))
      .where(inArray(walkthroughItems.condition, [...WALKTHROUGH_FLAGGED_CONDITIONS]))
      .orderBy(desc(walkthroughs.walkthroughDate), walkthroughRooms.displayOrder, walkthroughItems.displayOrder);

    return rows;
  }

  async updateWalkthroughItem(id: string, data: Partial<InsertWalkthroughItem>): Promise<WalkthroughItem> {
    const [row] = await db
      .update(walkthroughItems)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(walkthroughItems.id, id))
      .returning();
    return row;
  }

  async deleteWalkthroughItem(id: string): Promise<void> {
    await db.delete(walkthroughItems).where(eq(walkthroughItems.id, id));
  }

  // Walkthrough Rooms Implementation
  async getWalkthroughRoomsByWalkthrough(walkthroughId: string): Promise<WalkthroughRoom[]> {
    return await db
      .select()
      .from(walkthroughRooms)
      .where(eq(walkthroughRooms.walkthroughId, walkthroughId))
      .orderBy(walkthroughRooms.displayOrder);
  }

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

  async updateAsset(
    id: string,
    data: Partial<InsertAsset> & {
      snoozedByUserId?: string | null;
      snoozedAt?: Date | null;
      snoozedUntil?: Date | null;
    },
  ): Promise<Asset> {
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

  // Maintenance Schedules Implementation
  async createMaintenanceSchedule(scheduleData: InsertMaintenanceSchedule): Promise<MaintenanceSchedule> {
    const [schedule] = await db.insert(maintenanceSchedules).values(scheduleData).returning();
    return schedule;
  }

  async getMaintenanceSchedule(id: string): Promise<MaintenanceSchedule | undefined> {
    const [schedule] = await db.select().from(maintenanceSchedules).where(eq(maintenanceSchedules.id, id));
    return schedule;
  }

  async getAllMaintenanceSchedules(): Promise<MaintenanceSchedule[]> {
    return await db.select().from(maintenanceSchedules).orderBy(asc(maintenanceSchedules.nextDueDate));
  }

  async getMaintenanceSchedulesByProperty(propertyId: string): Promise<MaintenanceSchedule[]> {
    return await db
      .select()
      .from(maintenanceSchedules)
      .where(eq(maintenanceSchedules.propertyId, propertyId))
      .orderBy(asc(maintenanceSchedules.nextDueDate));
  }

  async updateMaintenanceSchedule(id: string, data: Partial<InsertMaintenanceSchedule>): Promise<MaintenanceSchedule> {
    const [schedule] = await db
      .update(maintenanceSchedules)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(maintenanceSchedules.id, id))
      .returning();
    return schedule;
  }

  async deleteMaintenanceSchedule(id: string): Promise<void> {
    await db.delete(maintenanceSchedules).where(eq(maintenanceSchedules.id, id));
  }

  async getDueMaintenanceSchedules(asOf: Date): Promise<MaintenanceSchedule[]> {
    return await db
      .select()
      .from(maintenanceSchedules)
      .where(and(eq(maintenanceSchedules.isActive, true), lte(maintenanceSchedules.nextDueDate, asOf)));
  }

  async markMaintenanceScheduleGenerated(id: string, dueDate: Date): Promise<void> {
    await db
      .update(maintenanceSchedules)
      .set({ lastGeneratedForDue: dueDate, updatedAt: new Date() })
      .where(eq(maintenanceSchedules.id, id));
  }

  async completeMaintenanceSchedule(id: string, completedDate: Date, nextDueDate: Date): Promise<MaintenanceSchedule> {
    const [schedule] = await db
      .update(maintenanceSchedules)
      .set({ lastCompletedDate: completedDate, nextDueDate, lastGeneratedForDue: null, updatedAt: new Date() })
      .where(eq(maintenanceSchedules.id, id))
      .returning();
    return schedule;
  }

  // Residents Implementation
  async createResident(residentData: InsertResident): Promise<Resident> {
    const [resident] = await db.insert(residents).values(residentData).returning();
    return resident;
  }

  async getResident(id: string): Promise<Resident | undefined> {
    const [resident] = await db.select().from(residents).where(eq(residents.id, id));
    return resident;
  }

  async getAllResidents(): Promise<Resident[]> {
    // Current residents first, then by name, so the roster reads naturally.
    return await db
      .select()
      .from(residents)
      .orderBy(desc(residents.isActive), asc(residents.lastName), asc(residents.firstName));
  }

  async getResidentsByProperty(propertyId: string): Promise<Resident[]> {
    return await db
      .select()
      .from(residents)
      .where(eq(residents.propertyId, propertyId))
      .orderBy(desc(residents.isActive), asc(residents.lastName), asc(residents.firstName));
  }

  async getActiveResidentByEmail(email: string): Promise<Resident | undefined> {
    // Matched case-insensitively: a login provider may return a different case
    // than the roster was entered in. Most recent active residency wins if the
    // same person appears more than once.
    const [resident] = await db
      .select()
      .from(residents)
      .where(and(ilike(residents.email, email), eq(residents.isActive, true)))
      .orderBy(desc(residents.createdAt))
      .limit(1);
    return resident;
  }

  async updateResident(id: string, data: Partial<InsertResident>): Promise<Resident> {
    const [resident] = await db
      .update(residents)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(residents.id, id))
      .returning();
    return resident;
  }

  async deleteResident(id: string): Promise<void> {
    await db.delete(residents).where(eq(residents.id, id));
  }

  // Rent Payments Implementation
  async createRentPayment(paymentData: InsertRentPayment): Promise<RentPayment> {
    const [payment] = await db.insert(rentPayments).values(paymentData).returning();
    return payment;
  }

  async getRentPayment(id: string): Promise<RentPayment | undefined> {
    const [payment] = await db.select().from(rentPayments).where(eq(rentPayments.id, id));
    return payment;
  }

  async getAllRentPayments(): Promise<RentPayment[]> {
    return await db.select().from(rentPayments).orderBy(desc(rentPayments.period));
  }

  async getRentPaymentsByProperty(propertyId: string): Promise<RentPayment[]> {
    return await db
      .select()
      .from(rentPayments)
      .where(eq(rentPayments.propertyId, propertyId))
      .orderBy(desc(rentPayments.period));
  }

  async getRentPaymentForResidentPeriod(residentId: string, period: string): Promise<RentPayment | undefined> {
    const [payment] = await db
      .select()
      .from(rentPayments)
      .where(and(eq(rentPayments.residentId, residentId), eq(rentPayments.period, period)));
    return payment;
  }

  async getLatestRentAmountForProperty(propertyId: string): Promise<string | undefined> {
    const [payment] = await db
      .select()
      .from(rentPayments)
      .where(eq(rentPayments.propertyId, propertyId))
      .orderBy(desc(rentPayments.createdAt))
      .limit(1);
    return payment?.amount;
  }

  async updateRentPayment(id: string, data: Partial<InsertRentPayment>): Promise<RentPayment> {
    const [payment] = await db
      .update(rentPayments)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(rentPayments.id, id))
      .returning();
    return payment;
  }

  async deleteRentPayment(id: string): Promise<void> {
    await db.delete(rentPayments).where(eq(rentPayments.id, id));
  }

  // Security Deposits Implementation
  async createSecurityDeposit(depositData: InsertSecurityDeposit): Promise<SecurityDeposit> {
    const [deposit] = await db.insert(securityDeposits).values(depositData).returning();
    return deposit;
  }

  async getSecurityDeposit(id: string): Promise<SecurityDeposit | undefined> {
    const [deposit] = await db.select().from(securityDeposits).where(eq(securityDeposits.id, id));
    return deposit;
  }

  async getAllSecurityDeposits(): Promise<SecurityDeposit[]> {
    return await db.select().from(securityDeposits).orderBy(desc(securityDeposits.createdAt));
  }

  async getSecurityDepositByResident(residentId: string): Promise<SecurityDeposit | undefined> {
    const [deposit] = await db.select().from(securityDeposits).where(eq(securityDeposits.residentId, residentId));
    return deposit;
  }

  async updateSecurityDeposit(id: string, data: Partial<InsertSecurityDeposit>): Promise<SecurityDeposit> {
    const [deposit] = await db
      .update(securityDeposits)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(securityDeposits.id, id))
      .returning();
    return deposit;
  }

  async deleteSecurityDeposit(id: string): Promise<void> {
    await db.delete(securityDeposits).where(eq(securityDeposits.id, id));
  }

  // Tasks Implementation
  async createTask(taskData: InsertTask & { createdBy: string | null; sourceKey?: string | null }): Promise<Task> {
    const [task] = await db.insert(tasks).values(taskData).returning();
    return task;
  }

  async getTask(id: string): Promise<Task | undefined> {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    return task;
  }

  async getTaskBySourceKey(sourceKey: string): Promise<Task | undefined> {
    const [task] = await db.select().from(tasks).where(eq(tasks.sourceKey, sourceKey));
    return task;
  }

  async getAllTasks(): Promise<Task[]> {
    // Open tasks first, then most recently created.
    return await db.select().from(tasks).orderBy(asc(tasks.status), desc(tasks.createdAt));
  }

  async updateTask(id: string, data: Partial<Task>): Promise<Task> {
    const [task] = await db
      .update(tasks)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();
    return task;
  }

  async deleteTask(id: string): Promise<void> {
    await db.delete(tasks).where(eq(tasks.id, id));
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

  async createAuditEvent(event: InsertAuditEvent): Promise<AuditEvent> {
    const [created] = await db.insert(auditLog).values(event).returning();
    return created;
  }

  async listAuditEvents(query: AuditEventQuery): Promise<AuditEventPage> {
    const conditions = [];
    if (query.from) conditions.push(gte(auditLog.createdAt, query.from));
    if (query.to) conditions.push(lt(auditLog.createdAt, query.to));
    if (query.action) conditions.push(eq(auditLog.action, query.action));
    if (query.actorEmail) {
      // A search box, so a partial match. The wildcards a user could type are
      // escaped: "%" typed into the box means the character, not "everything".
      const escaped = query.actorEmail.replace(/([\\%_])/g, "\\$1");
      conditions.push(ilike(auditLog.actorEmail, `%${escaped}%`));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // The count runs alongside the page rather than after it, and is what lets
    // the page show "of 12,480" without ever selecting 12,480 rows.
    const [events, [counted]] = await Promise.all([
      db
        .select()
        .from(auditLog)
        .where(where)
        // id breaks the tie: two events recorded in the same millisecond would
        // otherwise be free to swap places between pages and be shown twice or
        // not at all.
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ value: count() }).from(auditLog).where(where),
    ]);

    return { events, total: Number(counted?.value ?? 0) };
  }

  async deleteExpiredAuditEvents(
    before: Date,
    protectedActions: readonly string[],
    batchSize: number,
  ): Promise<number> {
    // Select a bounded set of IDs first. PostgreSQL has no portable DELETE ...
    // LIMIT syntax, and deleting by this small list keeps each transaction
    // short enough not to hold a table-wide lock during working hours.
    const expired = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          lt(auditLog.createdAt, before),
          notInArray(auditLog.action, [...protectedActions]),
        ),
      )
      .orderBy(asc(auditLog.createdAt))
      .limit(batchSize);

    if (expired.length === 0) return 0;

    const ids = expired.map(({ id }) => id);
    const deleted = await db.delete(auditLog).where(inArray(auditLog.id, ids)).returning({
      id: auditLog.id,
    });
    return deleted.length;
  }

  async createUpload(upload: InsertUpload): Promise<Upload> {
    const [created] = await db.insert(uploads).values(upload).returning();
    return created;
  }

  async getUploadByStorageKey(storageKey: string): Promise<Upload | undefined> {
    const [found] = await db.select().from(uploads).where(eq(uploads.storageKey, storageKey));
    return found;
  }

  // Contractor history Implementation
  //
  // Mostly a read over data that already exists: request_contacts has linked
  // vendors to requests all along, there was simply nowhere to read it from.
  async getRequestsForContact(contactId: string): Promise<MaintenanceRequest[]> {
    const rows = await db
      .select({ request: maintenanceRequests })
      .from(requestContacts)
      .innerJoin(maintenanceRequests, eq(requestContacts.requestId, maintenanceRequests.id))
      .where(eq(requestContacts.contactId, contactId))
      .orderBy(desc(maintenanceRequests.submittedDate));
    return rows.map((row) => row.request);
  }

  async getContactNotes(contactId: string): Promise<ContactNote[]> {
    return await db
      .select()
      .from(contactNotes)
      .where(eq(contactNotes.contactId, contactId))
      .orderBy(desc(contactNotes.createdAt));
  }

  async getContactNote(id: string): Promise<ContactNote | undefined> {
    const [row] = await db.select().from(contactNotes).where(eq(contactNotes.id, id));
    return row;
  }

  async createContactNote(
    note: InsertContactNote & { contactId: string; authorUserId: string | null; authorEmail: string | null; region: string },
  ): Promise<ContactNote> {
    const [row] = await db.insert(contactNotes).values(note).returning();
    return row;
  }

  async deleteContactNote(id: string): Promise<void> {
    await db.delete(contactNotes).where(eq(contactNotes.id, id));
  }

  // Property setup checklist Implementation
  async getPropertySetupItems(propertyId: string): Promise<PropertySetupItem[]> {
    return await db
      .select()
      .from(propertySetupItems)
      .where(eq(propertySetupItems.propertyId, propertyId));
  }

  async getAllPropertySetupItems(): Promise<PropertySetupItem[]> {
    return await db.select().from(propertySetupItems);
  }

  /**
   * Seeds a new house's checklist.
   *
   * `onConflictDoNothing` rather than an upsert: seeding runs once at property
   * creation, and a second run must never reset an item somebody has already
   * marked done.
   */
  async createPropertySetupItems(rows: InsertPropertySetupItem[]): Promise<PropertySetupItem[]> {
    if (rows.length === 0) return [];
    return await db
      .insert(propertySetupItems)
      .values(rows)
      .onConflictDoNothing({ target: [propertySetupItems.propertyId, propertySetupItems.itemKey] })
      .returning();
  }

  /**
   * Sets one item's state.
   *
   * An upsert rather than an update, because a house created before the
   * checklist existed has no rows at all -- an RA who starts filling one in is
   * creating it, and refusing them would make the feature unreachable for
   * every existing house.
   */
  async setPropertySetupItem(
    propertyId: string,
    itemKey: string,
    patch: { status: PropertySetupItem["status"]; note?: string | null; region: string; setByUserId: string | null; setAt: Date },
  ): Promise<PropertySetupItem> {
    const [row] = await db
      .insert(propertySetupItems)
      .values({
        propertyId,
        itemKey,
        status: patch.status,
        note: patch.note ?? null,
        region: patch.region,
        setByUserId: patch.setByUserId,
        setAt: patch.setAt,
      })
      .onConflictDoUpdate({
        target: [propertySetupItems.propertyId, propertySetupItems.itemKey],
        set: {
          status: patch.status,
          note: patch.note ?? null,
          region: patch.region,
          setByUserId: patch.setByUserId,
          setAt: patch.setAt,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async findUploadReferences(url: string): Promise<UploadReference[]> {
    // Each of these is the full set of columns in which the application stores
    // an uploaded file's URL. A new column holding one has to be added here, or
    // downloads of those files will be refused to everyone but the uploader.
    const [requests, requestPhotos, walkthrough, asset, billing, property] = await Promise.all([
      db.select().from(maintenanceRequests).where(eq(maintenanceRequests.photoUrl, url)),
      db.select().from(maintenanceRequestPhotos).where(eq(maintenanceRequestPhotos.imageUrl, url)),
      db.select().from(walkthroughPhotos).where(eq(walkthroughPhotos.imageUrl, url)),
      db.select().from(assetPhotos).where(eq(assetPhotos.imageUrl, url)),
      db
        .select()
        .from(billingRecords)
        .where(
          or(
            eq(billingRecords.contractInvoiceUrl, url),
            eq(billingRecords.coiUrl, url),
            eq(billingRecords.w9Url, url),
          ),
        ),
      db.select().from(properties).where(eq(properties.photoUrl, url)),
    ]);

    return [
      ...requests.map((record) => ({ kind: "maintenanceRequest" as const, record })),
      ...requestPhotos.map((record) => ({ kind: "maintenanceRequestPhoto" as const, record })),
      ...walkthrough.map((record) => ({ kind: "walkthroughPhoto" as const, record })),
      ...asset.map((record) => ({ kind: "assetPhoto" as const, record })),
      ...billing.map((record) => ({ kind: "billingRecord" as const, record })),
      ...property.map((record) => ({ kind: "property" as const, record })),
    ];
  }
}

export const storage = new DatabaseStorage();

import {
  users,
  userPermissions,
  maintenanceRequests,
  maintenanceRequestPhotos,
  maintenanceRequestComments,
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
  resourceLinks,
  residentDocuments,
  propertyBudgets,
  repairBudgets,
  quickbooksIntegration,
  propertyQuickbooksLinks,
  propertySpend,
  residentSheetLinks,
  rosterSyncRuns,
  rosterReviewItems,
  moveOutChecklists,
  moveOutPhotos,
  depositReturnRules,
  propertyFacts,
  residents,
  rentPayments,
  securityDeposits,
  depositDeductions,
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
  type MaintenanceRequestComment,
  type InsertMaintenanceRequestComment,
  maintenanceRequestBids,
  type MaintenanceRequestBid,
  type InsertMaintenanceRequestBid,
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
  type ResourceLink,
  type InsertResourceLink,
  type ResidentDocument,
  type PropertyBudget,
  type InsertPropertyBudget,
  type RepairBudget,
  type InsertRepairBudget,
  type QuickbooksIntegration,
  type PropertyQuickbooksLink,
  type PropertySpend,
  type ResidentSheetLink,
  type RosterSyncRun,
  type RosterReviewItem,
  type MoveOutChecklist,
  type MoveOutPhoto,
  type DepositReturnRule,
  type PropertyFacts,
  type PropertyFactsWrite,
  type MaintenanceSchedule,
  type InsertMaintenanceSchedule,
  type Resident,
  type InsertResident,
  type RentPayment,
  type InsertRentPayment,
  type SecurityDeposit,
  type InsertSecurityDeposit,
  type DepositDeduction,
  type InsertDepositDeduction,
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
import { eq, and, or, desc, asc, inArray, isNull, lt, lte, gte, ilike, like, count, notInArray, sql } from "drizzle-orm";

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
    // The new-surface flags start false for every role, including staff, and
    // turning one on is a data change rather than a code change. The resource
    // hub is the one a household leader needs: nobody has it until an admin
    // grants it, which is the same shape as walkthrough completion.
    canCompleteWalkthroughs: false,
    canManagePropertySetup: false,
    canViewResourceHub: false,
    allowedRegions: role === "admin" ? [...REGIONS] : [],
  };
}

/** Written by the dismiss routes only. */
export interface WalkthroughItemDismissFields {
  dismissedAt?: Date | null;
  dismissReason?: string | null;
  dismissedByUserId?: string | null;
}

/**
 * What deleting a house would take with it that nobody can rebuild: the
 * roster (moved-out residents included) and, by cascade from it, every HH fee,
 * deposit and deduction. Counted by the house's id.
 */
export interface PropertyDeleteBlockers {
  residents: number;
  hhFees: number;
  deposits: number;
  deductions: number;
}

/**
 * What `upsertUser` wrote, and whose account it was when the write was an
 * email re-link. `relinkedFrom` is set only when this call's own UPDATE moved
 * the row, so a sign-in racing another on the same email never reports the
 * other one's re-link.
 */
export interface UpsertUserResult {
  user: User;
  relinkedFrom?: Pick<User, "id" | "email" | "role">;
}

/** What the roster sync writes, already worked out (server/rosterSync.ts). */
export interface RosterPlanWrite {
  creates: Array<{ resident: InsertResident; syncedValues: Record<string, string | boolean | null> }>;
  updates: Array<{ id: string; data: Partial<InsertResident>; syncedValues: Record<string, string | boolean | null> }>;
  /** Residents already matching the sheet, whose synced values are (re)recorded. */
  links: Array<{ residentId: string; syncedValues: Record<string, string | boolean | null> }>;
  reviews: Array<Omit<RosterReviewItem, "id" | "status" | "reviewedByEmail" | "reviewedAt" | "createdAt">>;
  syncedAt: Date;
}

export interface IStorage {
  // User Management
  getUser(id: string): Promise<User | undefined>;
  /** The account holding exactly this email, the same match the sign-in re-link uses. */
  getUserByEmail(email: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<UpsertUserResult>;
  getAllUsers(): Promise<User[]>;
  /** Sets the role and, when given, replaces the permissions row in the same transaction. */
  updateUserRole(
    id: string,
    role: "admin" | "regional_administrator" | "resident",
    permissions: InsertUserPermissions | null,
  ): Promise<User>;
  updateUserActiveStatus(id: string, isActive: boolean): Promise<User>;
  updateUserProperty(id: string, propertyId: string | null): Promise<User>;
  deactivateAndUnlinkUser(id: string): Promise<User>;
  /** The comment email off switch. A preference, so it is not audited. */
  updateUserCommentEmails(id: string, enabled: boolean): Promise<User>;
  getActiveResidentAccountByEmail(email: string): Promise<User | undefined>;
  /**
   * Every account beside its permissions row, in one query. The candidate
   * list for the comment email; who among them is written to is decided in
   * commentRecipients.ts, not here.
   */
  getAllUsersWithPermissions(): Promise<{ user: User; permissions: UserPermissions | null }[]>;
  getUserPermissions(userId: string): Promise<UserPermissions | undefined>;
  getAllUserPermissions(): Promise<UserPermissions[]>;
  upsertUserPermissions(permissions: InsertUserPermissions): Promise<UserPermissions>;
  deleteUser(id: string): Promise<void>;

  // Maintenance Requests
  // walkthroughItemId is not part of the insert schema either: only the
  // send-to-maintenance route sets it, from the item it was called on.
  createMaintenanceRequest(
    request: InsertMaintenanceRequest & { completedDate?: Date | null; walkthroughItemId?: string | null },
  ): Promise<MaintenanceRequest>;
  getMaintenanceRequest(id: string): Promise<MaintenanceRequest | undefined>;
  /** The request already raised from a walkthrough item, if one was. */
  getMaintenanceRequestByWalkthroughItem(walkthroughItemId: string): Promise<MaintenanceRequest | undefined>;
  getAllMaintenanceRequests(): Promise<MaintenanceRequest[]>;
  // completedDate is not part of the insert schema -- it is set by the server
  // from a status transition, never accepted from a request body. See
  // server/maintenanceStatus.ts. null clears it when a request reopens.
  updateMaintenanceRequest(
    id: string,
    data: Partial<InsertMaintenanceRequest> & { completedDate?: Date | null },
  ): Promise<MaintenanceRequest>;
  // A delete that can take a stored file with it -- directly or through a
  // cascade -- returns the file URLs the removed rows held, so the route can
  // remove the objects too (server/uploadCleanup.ts).
  deleteMaintenanceRequest(id: string): Promise<string[]>;

  // Maintenance Request Photos
  createMaintenanceRequestPhoto(photo: InsertMaintenanceRequestPhoto & { uploadedBy: string }): Promise<MaintenanceRequestPhoto>;
  getMaintenanceRequestPhoto(id: string): Promise<MaintenanceRequestPhoto | undefined>;
  getMaintenanceRequestPhotosByRequest(requestId: string): Promise<MaintenanceRequestPhoto[]>;
  getAllMaintenanceRequestPhotos(): Promise<MaintenanceRequestPhoto[]>;
  deleteMaintenanceRequestPhoto(id: string): Promise<string[]>;

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
  deleteWalkthrough(id: string): Promise<string[]>;

  // Walkthrough Items
  createWalkthroughItem(item: InsertWalkthroughItem): Promise<WalkthroughItem>;
  getWalkthroughItem(id: string): Promise<WalkthroughItem | undefined>;
  getAllWalkthroughItems(): Promise<WalkthroughItem[]>;
  getWalkthroughItemsByRoom(roomId: string): Promise<WalkthroughItem[]>;
  getWalkthroughItemsByWalkthrough(walkthroughId: string): Promise<WalkthroughItem[]>;
  /** Every item recorded poor or damaged, newest walkthrough first. */
  getFlaggedWalkthroughItems(): Promise<FlaggedWalkthroughItem[]>;
  // The dismiss columns are outside the insert schema, so the dismiss routes
  // widen the type here exactly as the asset snooze does on updateAsset.
  updateWalkthroughItem(id: string, data: Partial<InsertWalkthroughItem> & WalkthroughItemDismissFields): Promise<WalkthroughItem>;
  deleteWalkthroughItem(id: string): Promise<void>;

  // Walkthrough Rooms
  getWalkthroughRoomsByWalkthrough(walkthroughId: string): Promise<WalkthroughRoom[]>;
  createWalkthroughRoom(room: InsertWalkthroughRoom): Promise<WalkthroughRoom>;
  getWalkthroughRoom(id: string): Promise<WalkthroughRoom | undefined>;
  getAllWalkthroughRooms(): Promise<WalkthroughRoom[]>;
  getWalkthroughRoomsByBuilding(buildingAddress: string): Promise<WalkthroughRoom[]>;
  updateWalkthroughRoom(id: string, data: Partial<InsertWalkthroughRoom>): Promise<WalkthroughRoom>;
  deleteWalkthroughRoom(id: string): Promise<string[]>;

  // Walkthrough Photos
  createWalkthroughPhoto(photo: InsertWalkthroughPhoto): Promise<WalkthroughPhoto>;
  getWalkthroughPhoto(id: string): Promise<WalkthroughPhoto | undefined>;
  getAllWalkthroughPhotos(): Promise<WalkthroughPhoto[]>;
  getWalkthroughPhotosByRoom(roomId: string): Promise<WalkthroughPhoto[]>;
  updateWalkthroughPhoto(id: string, data: Partial<InsertWalkthroughPhoto>): Promise<WalkthroughPhoto>;
  deleteWalkthroughPhoto(id: string): Promise<string[]>;

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
      snoozedUntil?: Date | null;
      snoozeReason?: string | null;
      snoozedByUserId?: string | null;
      snoozedAt?: Date | null;
    },
  ): Promise<Asset>;
  deleteAsset(id: string): Promise<string[]>;

  // Asset Photos
  createAssetPhoto(photo: InsertAssetPhoto): Promise<AssetPhoto>;
  getAssetPhoto(id: string): Promise<AssetPhoto | undefined>;
  getAssetPhotosByAsset(assetId: string): Promise<AssetPhoto[]>;
  getAllAssetPhotos(): Promise<AssetPhoto[]>;
  deleteAssetPhoto(id: string): Promise<string[]>;

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
  /** Several at once, in one insert: all of them or none. */
  createResidents(residents: InsertResident[]): Promise<Resident[]>;
  getResident(id: string): Promise<Resident | undefined>;
  getAllResidents(): Promise<Resident[]>;
  getResidentsByProperty(propertyId: string): Promise<Resident[]>;
  getActiveResidentByEmail(email: string): Promise<Resident | undefined>;
  /** `edited` marks the change as a person's (see residents.editedAt); the sheet sync never passes it. */
  updateResident(id: string, data: Partial<InsertResident>, edited?: { by: string | null; at: Date }): Promise<Resident>;
  /** Returns the file URLs the removed rows held (move-out photos), for cleanup. */
  deleteResident(id: string): Promise<string[]>;

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

  // Deposit deductions
  getAllDepositDeductions(): Promise<DepositDeduction[]>;
  getDepositDeduction(id: string): Promise<DepositDeduction | undefined>;
  getDepositDeductionsByResident(residentId: string): Promise<DepositDeduction[]>;
  createDepositDeduction(
    deduction: InsertDepositDeduction & DepositDeductionOwnedFields,
  ): Promise<DepositDeduction>;
  /** Writes a whole split at once, so a house is never half-charged. */
  createDepositDeductions(
    deductions: (InsertDepositDeduction & DepositDeductionOwnedFields)[],
  ): Promise<DepositDeduction[]>;
  updateDepositDeduction(id: string, data: Partial<InsertDepositDeduction>): Promise<DepositDeduction>;
  deleteDepositDeduction(id: string): Promise<void>;

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

  // Request threads
  /** Every comment on a request, oldest first: a thread reads top to bottom. */
  getMaintenanceRequestComments(requestId: string): Promise<MaintenanceRequestComment[]>;
  getMaintenanceRequestComment(id: string): Promise<MaintenanceRequestComment | undefined>;
  createMaintenanceRequestComment(
    comment: InsertMaintenanceRequestComment & {
      requestId: string;
      authorUserId: string | null;
      authorEmail: string | null;
      authorName: string | null;
    },
  ): Promise<MaintenanceRequestComment>;
  deleteMaintenanceRequestComment(id: string): Promise<string[]>;

  // Bids on a project
  /** Every bid on a request, oldest first, so the list reads in the order they came in. */
  getMaintenanceRequestBids(requestId: string): Promise<MaintenanceRequestBid[]>;
  getMaintenanceRequestBid(id: string): Promise<MaintenanceRequestBid | undefined>;
  createMaintenanceRequestBid(bid: InsertMaintenanceRequestBid & { requestId: string }): Promise<MaintenanceRequestBid>;
  updateMaintenanceRequestBid(id: string, data: Partial<InsertMaintenanceRequestBid>): Promise<MaintenanceRequestBid>;
  deleteMaintenanceRequestBid(id: string): Promise<string[]>;
  /**
   * Marks one bid accepted and every other bid on the request not, in one
   * transaction -- "at most one accepted bid" is enforced here, not by the
   * caller remembering to clear the others.
   */
  acceptMaintenanceRequestBid(requestId: string, bidId: string): Promise<MaintenanceRequestBid | undefined>;

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
  deleteBillingRecord(id: string): Promise<string[]>;

  // Properties
  createProperty(property: InsertPropertyWithAddress): Promise<Property>;
  getProperty(id: string): Promise<Property | undefined>;
  getPropertyByAddress(address: string): Promise<Property | undefined>;
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
  /** Every vendor-to-request link, for the contractor rollup. */
  getAllRequestContactLinks(): Promise<{ contactId: string; requestId: string }[]>;
  linkContactToRequest(requestId: string, contactId: string): Promise<void>;
  unlinkContactFromRequest(requestId: string, contactId: string): Promise<void>;
  updateProperty(id: string, data: Partial<InsertPropertyWithAddress>): Promise<Property>;
  getPropertyDeleteBlockers(id: string): Promise<PropertyDeleteBlockers>;
  deleteProperty(id: string): Promise<string[]>;

  // Resource hub
  getAllResourceLinks(): Promise<ResourceLink[]>;
  getResourceLink(id: string): Promise<ResourceLink | undefined>;
  createResourceLink(link: InsertResourceLink): Promise<ResourceLink>;
  updateResourceLink(id: string, data: Partial<InsertResourceLink>): Promise<ResourceLink>;
  deleteResourceLink(id: string): Promise<void>;

  // Liability paperwork
  getAllResidentDocuments(): Promise<ResidentDocument[]>;
  /** Sets one document's state, creating the row the first time. */
  setResidentDocument(
    residentId: string,
    documentKey: string,
    patch: {
      signedOn: Date | null;
      notes?: string | null;
      region: string;
      recordedByUserId: string | null;
      recordedByEmail: string | null;
    },
  ): Promise<ResidentDocument>;

  // Startup budgets
  getAllPropertyBudgets(): Promise<PropertyBudget[]>;
  /** Creates or replaces the figure for one house and year. */
  upsertPropertyBudget(budget: InsertPropertyBudget & { region: string }): Promise<PropertyBudget>;

  // Repair & maintenance budgets (owned houses, by fiscal year)
  getAllRepairBudgets(): Promise<RepairBudget[]>;
  getRepairBudget(propertyId: string, fiscalYear: number): Promise<RepairBudget | undefined>;
  upsertRepairBudget(budget: InsertRepairBudget & { region: string }): Promise<RepairBudget>;

  // QuickBooks: the one connection row, house links, and the synced spend
  getQuickbooksIntegration(): Promise<QuickbooksIntegration | undefined>;
  updateQuickbooksIntegration(patch: Partial<Omit<QuickbooksIntegration, "id" | "updatedAt">>): Promise<QuickbooksIntegration>;
  getAllPropertyQuickbooksLinks(): Promise<PropertyQuickbooksLink[]>;
  setPropertyQuickbooksLink(link: Omit<PropertyQuickbooksLink, "updatedAt">): Promise<PropertyQuickbooksLink>;
  deletePropertyQuickbooksLink(propertyId: string): Promise<boolean>;
  getAllPropertySpend(): Promise<PropertySpend[]>;
  /** Writes every row of one sync together, or none of them. */
  upsertPropertySpend(rows: Array<Omit<PropertySpend, "id">>): Promise<void>;

  // Resident roster sync
  getAllResidentSheetLinks(): Promise<ResidentSheetLink[]>;
  /** Applies a whole plan in one transaction and returns the residents it created. */
  applyRosterPlan(plan: RosterPlanWrite): Promise<Resident[]>;
  createRosterSyncRun(run: Omit<RosterSyncRun, "id" | "createdAt">): Promise<RosterSyncRun>;
  getRecentRosterSyncRuns(limit: number): Promise<RosterSyncRun[]>;
  getLastSuccessfulRosterSyncRun(): Promise<RosterSyncRun | undefined>;
  getRosterReviewItems(status: "open" | "reviewed", limit: number): Promise<RosterReviewItem[]>;
  markRosterReviewItemReviewed(id: string, byEmail: string | null): Promise<RosterReviewItem | undefined>;

  // Move-out
  getMoveOutChecklist(residentId: string): Promise<MoveOutChecklist | undefined>;
  upsertMoveOutChecklist(checklist: Omit<MoveOutChecklist, "updatedAt">): Promise<MoveOutChecklist>;
  getMoveOutPhotos(residentId: string): Promise<MoveOutPhoto[]>;
  getMoveOutPhoto(id: string): Promise<MoveOutPhoto | undefined>;
  createMoveOutPhoto(photo: Omit<MoveOutPhoto, "id" | "createdAt">): Promise<MoveOutPhoto>;
  /** Returns the removed photo's file URL, for cleanup. */
  deleteMoveOutPhoto(id: string): Promise<string[]>;
  getAllDepositReturnRules(): Promise<DepositReturnRule[]>;
  /** Null days removes the state's rule. */
  setDepositReturnRule(state: string, days: number | null, byEmail: string | null): Promise<void>;

  // House facts
  getPropertyFacts(propertyId: string): Promise<PropertyFacts | undefined>;
  /**
   * Creates or replaces the house's block. The three `...UpdatedAt` stamps
   * arrive already decided by the route (see server/houseFacts.ts); storage
   * writes what it is given and decides nothing about them.
   */
  upsertPropertyFacts(propertyId: string, facts: PropertyFactsWrite): Promise<PropertyFacts>;

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
  deleteUpload(storageKey: string): Promise<void>;
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

/**
 * The parts of a deduction the SERVER supplies rather than the caller.
 *
 * The property, region and house are copied from the resident the deduction is
 * against, so a body cannot name a region it cannot reach; the actor comes
 * from the session; the split group id is set by the split route alone. Named
 * once because four signatures need it and four copies is four places to
 * quietly drop one of them.
 */
export interface DepositDeductionOwnedFields {
  propertyId: string;
  region: string;
  buildingAddress: string;
  splitGroupId?: string | null;
  recordedByUserId: string | null;
  recordedByEmail: string | null;
}

export type UploadReference =
  | { kind: "maintenanceRequest"; record: MaintenanceRequest }
  | { kind: "maintenanceRequestPhoto"; record: MaintenanceRequestPhoto }
  | { kind: "maintenanceRequestComment"; record: MaintenanceRequestComment }
  | { kind: "maintenanceRequestBid"; record: MaintenanceRequestBid }
  | { kind: "walkthroughPhoto"; record: WalkthroughPhoto }
  | { kind: "assetPhoto"; record: AssetPhoto }
  | { kind: "billingRecord"; record: BillingRecord }
  | { kind: "property"; record: Property }
  | { kind: "moveOutPhoto"; record: MoveOutPhoto };

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user;
  }

  /**
   * Handles an account an admin pre-created by email under a different ID (or
   * one kept from a previous login provider): when its owner signs in, the
   * provider's subject differs from the stored ID. The account is renamed to
   * the new identity in place, in a single UPDATE, so it is all-or-nothing:
   * every foreign key to users.id is ON UPDATE CASCADE, and the permissions
   * row, task assignments, comment authorship and every other reference move
   * with it inside the same statement. A failure leaves the old account
   * exactly as it was.
   *
   * Returns undefined when there is nothing to re-link, including when a
   * concurrent sign-in renamed the account between the lookup and the UPDATE.
   */
  private async relinkByEmail(userData: UpsertUser): Promise<UpsertUserResult | undefined> {
    if (!userData.email || !userData.id) return undefined;

    const existingByEmail = await this.getUserByEmail(userData.email);
    if (!existingByEmail || existingByEmail.id === userData.id) return undefined;

    // Role, active status, the property link (a pre-created resident account
    // already points at its house; the sign-in claims never carry propertyId)
    // and the comment email switch, which an admin may already have turned
    // off, all stay as the admin set them. A claim the provider left
    // undefined is skipped by the update, so it never blanks a stored value.
    const [relinked] = await db
      .update(users)
      .set({
        ...userData,
        role: existingByEmail.role,
        isActive: existingByEmail.isActive,
        propertyId: userData.propertyId ?? existingByEmail.propertyId,
        commentEmailsEnabled: existingByEmail.commentEmailsEnabled,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existingByEmail.id))
      .returning();
    if (!relinked) return undefined;
    const { id, email, role } = existingByEmail;
    return { user: relinked, relinkedFrom: { id, email, role } };
  }

  async upsertUser(userData: UpsertUser): Promise<UpsertUserResult> {
    const relink = await this.relinkByEmail(userData);
    const user =
      relink?.user ??
      (
        await db
          .insert(users)
          .values(userData)
          .onConflictDoUpdate({
            target: users.id,
            set: {
              ...userData,
              updatedAt: new Date(),
            },
          })
          .returning()
      )[0];

    const existingPermissions = await this.getUserPermissions(user.id);
    if (!existingPermissions) {
      const defaultPermissions = computeDefaultPermissions(user.id, user.role);
      await this.upsertUserPermissions(defaultPermissions);
    }

    return { user, relinkedFrom: relink?.relinkedFrom };
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users);
  }

  async getActiveResidentAccountByEmail(email: string): Promise<User | undefined> {
    // Case-insensitive like the roster lookup: the roster email is typed by
    // staff, the login email comes from the identity provider, and the two
    // can disagree on case. An exact comparison rather than ILIKE, so a `_` or
    // `%` in an address matches only itself. Restricted to active
    // resident-role accounts because that is the only kind of login a roster
    // row can speak for.
    const [user] = await db
      .select()
      .from(users)
      .where(and(sql`lower(${users.email}) = lower(${email})`, eq(users.role, "resident"), eq(users.isActive, true)))
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

  // What the permissions row becomes is decided by permissionsAfterRoleChange
  // in server/roleChange.ts; this only writes it. One transaction, so a role
  // never lands without the reset that goes with it.
  async updateUserRole(
    id: string,
    role: "admin" | "regional_administrator" | "resident",
    permissions: InsertUserPermissions | null,
  ): Promise<User> {
    return db.transaction(async (tx) => {
      const [user] = await tx.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, id)).returning();
      if (permissions) {
        await tx
          .insert(userPermissions)
          .values(permissions)
          .onConflictDoUpdate({ target: userPermissions.userId, set: { ...permissions, updatedAt: new Date() } });
      }
      return user;
    });
  }

  // Move-out switches a login off and unlinks it from its house in one
  // statement: done as two, a failure between them would leave an inactive
  // login still linked, which a retry cannot find to repair.
  async deactivateAndUnlinkUser(id: string): Promise<User> {
    const [user] = await db
      .update(users)
      .set({ isActive: false, propertyId: null, updatedAt: new Date() })
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

  async updateUserCommentEmails(id: string, enabled: boolean): Promise<User> {
    const [user] = await db
      .update(users)
      .set({ commentEmailsEnabled: enabled, updatedAt: new Date() })
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

  async getAllUsersWithPermissions(): Promise<{ user: User; permissions: UserPermissions | null }[]> {
    return await db
      .select({ user: users, permissions: userPermissions })
      .from(users)
      .leftJoin(userPermissions, eq(userPermissions.userId, users.id));
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
    requestData: InsertMaintenanceRequest & { completedDate?: Date | null; walkthroughItemId?: string | null },
  ): Promise<MaintenanceRequest> {
    const [request] = await db.insert(maintenanceRequests).values(requestData).returning();
    return request;
  }

  async getMaintenanceRequestByWalkthroughItem(walkthroughItemId: string): Promise<MaintenanceRequest | undefined> {
    const [request] = await db
      .select()
      .from(maintenanceRequests)
      .where(eq(maintenanceRequests.walkthroughItemId, walkthroughItemId))
      .orderBy(desc(maintenanceRequests.submittedDate))
      .limit(1);
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

  async deleteMaintenanceRequest(id: string): Promise<string[]> {
    // The photos, comments and bids go with the request by cascade, so their
    // files are read first, in the same transaction as the delete.
    return await db.transaction(async (tx) => {
      const photos = await tx
        .select({ url: maintenanceRequestPhotos.imageUrl })
        .from(maintenanceRequestPhotos)
        .where(eq(maintenanceRequestPhotos.requestId, id));
      const comments = await tx
        .select({ url: maintenanceRequestComments.attachmentUrl })
        .from(maintenanceRequestComments)
        .where(eq(maintenanceRequestComments.requestId, id));
      const bids = await tx
        .select({ url: maintenanceRequestBids.documentUrl })
        .from(maintenanceRequestBids)
        .where(eq(maintenanceRequestBids.requestId, id));
      const deleted = await tx
        .delete(maintenanceRequests)
        .where(eq(maintenanceRequests.id, id))
        .returning({ url: maintenanceRequests.photoUrl });
      return fileUrls([...photos, ...comments, ...bids, ...deleted]);
    });
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

  async deleteMaintenanceRequestPhoto(id: string): Promise<string[]> {
    const deleted = await db
      .delete(maintenanceRequestPhotos)
      .where(eq(maintenanceRequestPhotos.id, id))
      .returning({ url: maintenanceRequestPhotos.imageUrl });
    return fileUrls(deleted);
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

  async deleteWalkthrough(id: string): Promise<string[]> {
    // Rooms go with the walkthrough, and photos with the rooms, by cascade.
    return await db.transaction(async (tx) => {
      const photos = await tx
        .select({ url: walkthroughPhotos.imageUrl })
        .from(walkthroughPhotos)
        .innerJoin(walkthroughRooms, eq(walkthroughPhotos.roomId, walkthroughRooms.id))
        .where(eq(walkthroughRooms.walkthroughId, id));
      await tx.delete(walkthroughs).where(eq(walkthroughs.id, id));
      return fileUrls(photos);
    });
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
      // A dismissed item is off this list and nowhere else: it still shows,
      // as dismissed, on its walkthrough.
      .where(and(inArray(walkthroughItems.condition, [...WALKTHROUGH_FLAGGED_CONDITIONS]), isNull(walkthroughItems.dismissedAt)))
      .orderBy(desc(walkthroughs.walkthroughDate), walkthroughRooms.displayOrder, walkthroughItems.displayOrder);

    return rows;
  }

  async updateWalkthroughItem(id: string, data: Partial<InsertWalkthroughItem> & WalkthroughItemDismissFields): Promise<WalkthroughItem> {
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

  async deleteWalkthroughRoom(id: string): Promise<string[]> {
    return await db.transaction(async (tx) => {
      const photos = await tx
        .select({ url: walkthroughPhotos.imageUrl })
        .from(walkthroughPhotos)
        .where(eq(walkthroughPhotos.roomId, id));
      await tx.delete(walkthroughRooms).where(eq(walkthroughRooms.id, id));
      return fileUrls(photos);
    });
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

  async deleteWalkthroughPhoto(id: string): Promise<string[]> {
    const deleted = await db
      .delete(walkthroughPhotos)
      .where(eq(walkthroughPhotos.id, id))
      .returning({ url: walkthroughPhotos.imageUrl });
    return fileUrls(deleted);
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
      snoozedUntil?: Date | null;
      snoozeReason?: string | null;
      snoozedByUserId?: string | null;
      snoozedAt?: Date | null;
    },
  ): Promise<Asset> {
    const [asset] = await db
      .update(assets)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(assets.id, id))
      .returning();
    return asset;
  }

  async deleteAsset(id: string): Promise<string[]> {
    return await db.transaction(async (tx) => {
      const photos = await tx
        .select({ url: assetPhotos.imageUrl })
        .from(assetPhotos)
        .where(eq(assetPhotos.assetId, id));
      await tx.delete(assets).where(eq(assets.id, id));
      return fileUrls(photos);
    });
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

  async createResidents(residentRows: InsertResident[]): Promise<Resident[]> {
    // One statement is atomic on its own; no transaction needed.
    if (residentRows.length === 0) return [];
    return await db.insert(residents).values(residentRows).returning();
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
    // than the roster was entered in. Exact rather than ILIKE, so a `_` or `%`
    // matches only itself. Most recent active residency wins if the same
    // person appears more than once.
    const [resident] = await db
      .select()
      .from(residents)
      .where(and(sql`lower(${residents.email}) = lower(${email})`, eq(residents.isActive, true)))
      .orderBy(desc(residents.createdAt))
      .limit(1);
    return resident;
  }

  async updateResident(id: string, data: Partial<InsertResident>, edited?: { by: string | null; at: Date }): Promise<Resident> {
    const [resident] = await db
      .update(residents)
      .set({
        ...filterUndefined(data),
        ...(edited ? { editedAt: edited.at, editedByEmail: edited.by } : {}),
        updatedAt: new Date(),
      })
      .where(eq(residents.id, id))
      .returning();
    return resident;
  }

  async deleteResident(id: string): Promise<string[]> {
    // Move-out photos go with the resident by cascade; their files are the
    // caller's to remove once the row is gone.
    return await db.transaction(async (tx) => {
      const photos = await tx.select({ url: moveOutPhotos.imageUrl }).from(moveOutPhotos).where(eq(moveOutPhotos.residentId, id));
      await tx.delete(residents).where(eq(residents.id, id));
      return fileUrls(photos);
    });
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

  async deleteAssetPhoto(id: string): Promise<string[]> {
    const deleted = await db
      .delete(assetPhotos)
      .where(eq(assetPhotos.id, id))
      .returning({ url: assetPhotos.imageUrl });
    return fileUrls(deleted);
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

  async deleteBillingRecord(id: string): Promise<string[]> {
    const deleted = await db
      .delete(billingRecords)
      .where(eq(billingRecords.id, id))
      .returning({
        contractInvoiceUrl: billingRecords.contractInvoiceUrl,
        coiUrl: billingRecords.coiUrl,
        w9Url: billingRecords.w9Url,
      });
    return fileUrls(
      deleted.flatMap((row) => [{ url: row.contractInvoiceUrl }, { url: row.coiUrl }, { url: row.w9Url }]),
    );
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

  async getPropertyByAddress(address: string): Promise<Property | undefined> {
    const [property] = await db.select().from(properties).where(eq(properties.address, address));
    return property;
  }

  async getAllProperties(): Promise<Property[]> {
    return await db.select().from(properties);
  }

  async updateProperty(id: string, data: Partial<InsertPropertyWithAddress>): Promise<Property> {
    return await db.transaction(async (tx) => {
      const [current] = await tx.select().from(properties).where(eq(properties.id, id)).for("update");
      const [property] = await tx
        .update(properties)
        .set({ ...filterUndefined(data), updatedAt: new Date() })
        .where(eq(properties.id, id))
        .returning();
      if (!current || data.region === undefined || data.region === current.region) return property;

      // A region move. Region scoping reads each record's own copy of its
      // house's region, so every copy moves with the house, in this same
      // transaction -- otherwise the old region's RA keeps the roster, the
      // fees and the requests, and the new one sees none of them. Requests and
      // invoices know their house only by address: the address it had before
      // this edit, since the same edit may change it.
      const region = data.region;
      const houseWalkthroughs = tx
        .select({ id: walkthroughs.id })
        .from(walkthroughs)
        .where(eq(walkthroughs.propertyId, id));
      const houseRooms = tx
        .select({ id: walkthroughRooms.id })
        .from(walkthroughRooms)
        .where(or(eq(walkthroughRooms.propertyId, id), inArray(walkthroughRooms.walkthroughId, houseWalkthroughs)));
      const houseResidents = tx
        .select({ id: residents.id })
        .from(residents)
        .where(eq(residents.propertyId, id));

      await tx.update(residentDocuments).set({ region }).where(inArray(residentDocuments.residentId, houseResidents));
      await tx.update(walkthroughPhotos).set({ region }).where(inArray(walkthroughPhotos.roomId, houseRooms));
      await tx.update(residents).set({ region }).where(eq(residents.propertyId, id));
      await tx.update(moveOutChecklists).set({ region }).where(inArray(moveOutChecklists.residentId, houseResidents));
      await tx.update(moveOutPhotos).set({ region }).where(inArray(moveOutPhotos.residentId, houseResidents));
      // The move-out reminders are generated per resident (server/moveOut.ts).
      await tx
        .update(tasks)
        .set({ region })
        .where(and(like(tasks.sourceKey, "move-out:%"), inArray(sql`split_part(${tasks.sourceKey}, ':', 2)`, houseResidents)));
      await tx.update(rentPayments).set({ region }).where(eq(rentPayments.propertyId, id));
      await tx.update(securityDeposits).set({ region }).where(eq(securityDeposits.propertyId, id));
      await tx.update(depositDeductions).set({ region }).where(eq(depositDeductions.propertyId, id));
      await tx.update(walkthroughs).set({ region }).where(eq(walkthroughs.propertyId, id));
      await tx.update(maintenanceSchedules).set({ region }).where(eq(maintenanceSchedules.propertyId, id));
      await tx.update(propertySetupItems).set({ region }).where(eq(propertySetupItems.propertyId, id));
      await tx.update(propertyBudgets).set({ region }).where(eq(propertyBudgets.propertyId, id));
      await tx.update(repairBudgets).set({ region }).where(eq(repairBudgets.propertyId, id));
      await tx.update(propertyQuickbooksLinks).set({ region }).where(eq(propertyQuickbooksLinks.propertyId, id));
      await tx.update(propertySpend).set({ region }).where(eq(propertySpend.propertyId, id));
      await tx.update(assets).set({ region }).where(eq(assets.propertyId, id));
      await tx.update(maintenanceRequests).set({ region }).where(eq(maintenanceRequests.buildingAddress, current.address));
      await tx.update(invoices).set({ region }).where(eq(invoices.buildingAddress, current.address));
      // The lease reminders are generated per house (server/seasonalTasks.ts).
      await tx
        .update(tasks)
        .set({ region })
        .where(or(like(tasks.sourceKey, `lease-renewal:${id}:%`), like(tasks.sourceKey, `utilities-lease:${id}:%`)));
      return property;
    });
  }

  async getPropertyDeleteBlockers(id: string): Promise<PropertyDeleteBlockers> {
    const [[roster], [fees], [deposits], [deductions]] = await Promise.all([
      db.select({ value: count() }).from(residents).where(eq(residents.propertyId, id)),
      db.select({ value: count() }).from(rentPayments).where(eq(rentPayments.propertyId, id)),
      db.select({ value: count() }).from(securityDeposits).where(eq(securityDeposits.propertyId, id)),
      db.select({ value: count() }).from(depositDeductions).where(eq(depositDeductions.propertyId, id)),
    ]);
    return {
      residents: roster.value,
      hhFees: fees.value,
      deposits: deposits.value,
      deductions: deductions.value,
    };
  }

  async deleteProperty(id: string): Promise<string[]> {
    // The house's walkthroughs go with it by cascade, and their rooms' photos
    // with them. Assets and requests are not cascaded, so their files stay
    // with the rows that still point at them.
    return await db.transaction(async (tx) => {
      const photos = await tx
        .select({ url: walkthroughPhotos.imageUrl })
        .from(walkthroughPhotos)
        .innerJoin(walkthroughRooms, eq(walkthroughPhotos.roomId, walkthroughRooms.id))
        .innerJoin(walkthroughs, eq(walkthroughRooms.walkthroughId, walkthroughs.id))
        .where(eq(walkthroughs.propertyId, id));
      const moveOut = await tx
        .select({ url: moveOutPhotos.imageUrl })
        .from(moveOutPhotos)
        .innerJoin(residents, eq(moveOutPhotos.residentId, residents.id))
        .where(eq(residents.propertyId, id));
      const deleted = await tx
        .delete(properties)
        .where(eq(properties.id, id))
        .returning({ url: properties.photoUrl });
      return fileUrls([...photos, ...moveOut, ...deleted]);
    });
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

  async deleteUpload(storageKey: string): Promise<void> {
    await db.delete(uploads).where(eq(uploads.storageKey, storageKey));
  }

  async getUploadByStorageKey(storageKey: string): Promise<Upload | undefined> {
    const [found] = await db.select().from(uploads).where(eq(uploads.storageKey, storageKey));
    return found;
  }

  async getAllRequestContactLinks(): Promise<{ contactId: string; requestId: string }[]> {
    return await db
      .select({ contactId: requestContacts.contactId, requestId: requestContacts.requestId })
      .from(requestContacts);
  }

  // Resource hub Implementation
  async getAllResourceLinks(): Promise<ResourceLink[]> {
    return await db
      .select()
      .from(resourceLinks)
      .orderBy(resourceLinks.category, resourceLinks.displayOrder, resourceLinks.title);
  }

  async getResourceLink(id: string): Promise<ResourceLink | undefined> {
    const [row] = await db.select().from(resourceLinks).where(eq(resourceLinks.id, id));
    return row;
  }

  async createResourceLink(link: InsertResourceLink): Promise<ResourceLink> {
    const [row] = await db.insert(resourceLinks).values(link).returning();
    return row;
  }

  async updateResourceLink(id: string, data: Partial<InsertResourceLink>): Promise<ResourceLink> {
    const [row] = await db
      .update(resourceLinks)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(resourceLinks.id, id))
      .returning();
    return row;
  }

  async deleteResourceLink(id: string): Promise<void> {
    await db.delete(resourceLinks).where(eq(resourceLinks.id, id));
  }

  // Liability paperwork Implementation
  async getAllResidentDocuments(): Promise<ResidentDocument[]> {
    return await db.select().from(residentDocuments);
  }

  /**
   * An upsert rather than an update: nobody's paperwork rows exist until
   * somebody first records something, so an RA ticking the first box is
   * creating the row.
   */
  async setResidentDocument(
    residentId: string,
    documentKey: string,
    patch: {
      signedOn: Date | null;
      notes?: string | null;
      region: string;
      recordedByUserId: string | null;
      recordedByEmail: string | null;
    },
  ): Promise<ResidentDocument> {
    const [row] = await db
      .insert(residentDocuments)
      .values({
        residentId,
        documentKey,
        signedOn: patch.signedOn,
        notes: patch.notes ?? null,
        region: patch.region,
        recordedByUserId: patch.recordedByUserId,
        recordedByEmail: patch.recordedByEmail,
      })
      .onConflictDoUpdate({
        target: [residentDocuments.residentId, residentDocuments.documentKey],
        set: {
          signedOn: patch.signedOn,
          notes: patch.notes ?? null,
          region: patch.region,
          recordedByUserId: patch.recordedByUserId,
          recordedByEmail: patch.recordedByEmail,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  // Startup budgets Implementation
  async getAllPropertyBudgets(): Promise<PropertyBudget[]> {
    return await db.select().from(propertyBudgets).orderBy(desc(propertyBudgets.year));
  }

  async upsertPropertyBudget(budget: InsertPropertyBudget & { region: string }): Promise<PropertyBudget> {
    const [row] = await db
      .insert(propertyBudgets)
      .values(budget)
      .onConflictDoUpdate({
        target: [propertyBudgets.propertyId, propertyBudgets.year],
        set: { amount: budget.amount, notes: budget.notes ?? null, region: budget.region, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  // Repair & maintenance budgets Implementation
  async getAllRepairBudgets(): Promise<RepairBudget[]> {
    return await db.select().from(repairBudgets).orderBy(desc(repairBudgets.fiscalYear));
  }

  async getRepairBudget(propertyId: string, fiscalYear: number): Promise<RepairBudget | undefined> {
    const [row] = await db
      .select()
      .from(repairBudgets)
      .where(and(eq(repairBudgets.propertyId, propertyId), eq(repairBudgets.fiscalYear, fiscalYear)));
    return row;
  }

  async upsertRepairBudget(budget: InsertRepairBudget & { region: string }): Promise<RepairBudget> {
    const [row] = await db
      .insert(repairBudgets)
      .values(budget)
      .onConflictDoUpdate({
        target: [repairBudgets.propertyId, repairBudgets.fiscalYear],
        set: { amount: budget.amount, region: budget.region, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  // QuickBooks Implementation
  async getQuickbooksIntegration(): Promise<QuickbooksIntegration | undefined> {
    const [row] = await db.select().from(quickbooksIntegration).where(eq(quickbooksIntegration.id, "default"));
    return row;
  }

  async updateQuickbooksIntegration(
    patch: Partial<Omit<QuickbooksIntegration, "id" | "updatedAt">>,
  ): Promise<QuickbooksIntegration> {
    const [row] = await db
      .insert(quickbooksIntegration)
      .values({ id: "default", ...patch })
      .onConflictDoUpdate({ target: quickbooksIntegration.id, set: { ...patch, updatedAt: new Date() } })
      .returning();
    return row;
  }

  async getAllPropertyQuickbooksLinks(): Promise<PropertyQuickbooksLink[]> {
    return await db.select().from(propertyQuickbooksLinks);
  }

  async setPropertyQuickbooksLink(link: Omit<PropertyQuickbooksLink, "updatedAt">): Promise<PropertyQuickbooksLink> {
    const [row] = await db
      .insert(propertyQuickbooksLinks)
      .values(link)
      .onConflictDoUpdate({
        target: propertyQuickbooksLinks.propertyId,
        set: { kind: link.kind, externalId: link.externalId, externalName: link.externalName, region: link.region, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  async deletePropertyQuickbooksLink(propertyId: string): Promise<boolean> {
    const removed = await db
      .delete(propertyQuickbooksLinks)
      .where(eq(propertyQuickbooksLinks.propertyId, propertyId))
      .returning({ propertyId: propertyQuickbooksLinks.propertyId });
    return removed.length > 0;
  }

  async getAllPropertySpend(): Promise<PropertySpend[]> {
    return await db.select().from(propertySpend);
  }

  async upsertPropertySpend(rows: Array<Omit<PropertySpend, "id">>): Promise<void> {
    if (rows.length === 0) return;
    await db.transaction(async (tx) => {
      for (const row of rows) {
        await tx
          .insert(propertySpend)
          .values(row)
          .onConflictDoUpdate({
            target: [propertySpend.propertyId, propertySpend.fiscalYear],
            set: { amount: row.amount, region: row.region, syncedAt: row.syncedAt },
          });
      }
    });
  }

  // Resident roster sync Implementation
  async getAllResidentSheetLinks(): Promise<ResidentSheetLink[]> {
    return await db.select().from(residentSheetLinks);
  }

  async applyRosterPlan(plan: RosterPlanWrite): Promise<Resident[]> {
    return await db.transaction(async (tx) => {
      const link = async (residentId: string, syncedValues: Record<string, string | boolean | null>) =>
        await tx
          .insert(residentSheetLinks)
          .values({ residentId, syncedValues, syncedAt: plan.syncedAt })
          .onConflictDoUpdate({ target: residentSheetLinks.residentId, set: { syncedValues, syncedAt: plan.syncedAt } });

      const created: Resident[] = [];
      for (const c of plan.creates) {
        const [row] = await tx.insert(residents).values(c.resident).returning();
        await link(row.id, c.syncedValues);
        created.push(row);
      }
      for (const u of plan.updates) {
        // Not a person's edit: editedAt/editedByEmail are left as they were.
        await tx.update(residents).set({ ...filterUndefined(u.data), updatedAt: new Date() }).where(eq(residents.id, u.id));
        await link(u.id, u.syncedValues);
      }
      for (const l of plan.links) await link(l.residentId, l.syncedValues);
      // One open item per key (a partial unique index): a repeat is a no-op.
      for (const r of plan.reviews) await tx.insert(rosterReviewItems).values(r).onConflictDoNothing();
      return created;
    });
  }

  async createRosterSyncRun(run: Omit<RosterSyncRun, "id" | "createdAt">): Promise<RosterSyncRun> {
    const [row] = await db.insert(rosterSyncRuns).values(run).returning();
    return row;
  }

  async getRecentRosterSyncRuns(limit: number): Promise<RosterSyncRun[]> {
    return await db.select().from(rosterSyncRuns).orderBy(desc(rosterSyncRuns.createdAt)).limit(limit);
  }

  async getLastSuccessfulRosterSyncRun(): Promise<RosterSyncRun | undefined> {
    const [row] = await db
      .select()
      .from(rosterSyncRuns)
      .where(and(eq(rosterSyncRuns.ok, true), eq(rosterSyncRuns.dryRun, false), eq(rosterSyncRuns.source, "sheet")))
      .orderBy(desc(rosterSyncRuns.createdAt))
      .limit(1);
    return row;
  }

  async getRosterReviewItems(status: "open" | "reviewed", limit: number): Promise<RosterReviewItem[]> {
    return await db
      .select()
      .from(rosterReviewItems)
      .where(eq(rosterReviewItems.status, status))
      .orderBy(desc(rosterReviewItems.createdAt))
      .limit(limit);
  }

  async markRosterReviewItemReviewed(id: string, byEmail: string | null): Promise<RosterReviewItem | undefined> {
    const [row] = await db
      .update(rosterReviewItems)
      .set({ status: "reviewed", reviewedByEmail: byEmail, reviewedAt: new Date() })
      .where(and(eq(rosterReviewItems.id, id), eq(rosterReviewItems.status, "open")))
      .returning();
    return row;
  }

  // Move-out Implementation
  async getMoveOutChecklist(residentId: string): Promise<MoveOutChecklist | undefined> {
    const [row] = await db.select().from(moveOutChecklists).where(eq(moveOutChecklists.residentId, residentId));
    return row;
  }

  async upsertMoveOutChecklist(checklist: Omit<MoveOutChecklist, "updatedAt">): Promise<MoveOutChecklist> {
    const { residentId: _id, ...rest } = checklist;
    const [row] = await db
      .insert(moveOutChecklists)
      .values(checklist)
      .onConflictDoUpdate({ target: moveOutChecklists.residentId, set: { ...rest, updatedAt: new Date() } })
      .returning();
    return row;
  }

  async getMoveOutPhotos(residentId: string): Promise<MoveOutPhoto[]> {
    return await db.select().from(moveOutPhotos).where(eq(moveOutPhotos.residentId, residentId)).orderBy(asc(moveOutPhotos.createdAt));
  }

  async getMoveOutPhoto(id: string): Promise<MoveOutPhoto | undefined> {
    const [row] = await db.select().from(moveOutPhotos).where(eq(moveOutPhotos.id, id));
    return row;
  }

  async createMoveOutPhoto(photo: Omit<MoveOutPhoto, "id" | "createdAt">): Promise<MoveOutPhoto> {
    const [row] = await db.insert(moveOutPhotos).values(photo).returning();
    return row;
  }

  async deleteMoveOutPhoto(id: string): Promise<string[]> {
    return fileUrls(await db.delete(moveOutPhotos).where(eq(moveOutPhotos.id, id)).returning({ url: moveOutPhotos.imageUrl }));
  }

  async getAllDepositReturnRules(): Promise<DepositReturnRule[]> {
    return await db.select().from(depositReturnRules).orderBy(asc(depositReturnRules.state));
  }

  async setDepositReturnRule(state: string, days: number | null, byEmail: string | null): Promise<void> {
    if (days === null) {
      await db.delete(depositReturnRules).where(eq(depositReturnRules.state, state));
      return;
    }
    await db
      .insert(depositReturnRules)
      .values({ state, days, updatedByEmail: byEmail })
      .onConflictDoUpdate({ target: depositReturnRules.state, set: { days, updatedByEmail: byEmail, updatedAt: new Date() } });
  }

  // House facts Implementation
  async getPropertyFacts(propertyId: string): Promise<PropertyFacts | undefined> {
    const [row] = await db.select().from(propertyFacts).where(eq(propertyFacts.propertyId, propertyId));
    return row;
  }

  async upsertPropertyFacts(propertyId: string, facts: PropertyFactsWrite): Promise<PropertyFacts> {
    const [row] = await db
      .insert(propertyFacts)
      .values({ propertyId, ...facts })
      .onConflictDoUpdate({
        target: propertyFacts.propertyId,
        set: { ...facts, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  // Deposit deductions Implementation
  async getAllDepositDeductions(): Promise<DepositDeduction[]> {
    return await db.select().from(depositDeductions).orderBy(desc(depositDeductions.chargeDate));
  }

  async getDepositDeduction(id: string): Promise<DepositDeduction | undefined> {
    const [row] = await db.select().from(depositDeductions).where(eq(depositDeductions.id, id));
    return row;
  }

  async getDepositDeductionsByResident(residentId: string): Promise<DepositDeduction[]> {
    return await db
      .select()
      .from(depositDeductions)
      .where(eq(depositDeductions.residentId, residentId))
      .orderBy(desc(depositDeductions.chargeDate));
  }

  async createDepositDeduction(
    deduction: InsertDepositDeduction & DepositDeductionOwnedFields,
  ): Promise<DepositDeduction> {
    const [row] = await db.insert(depositDeductions).values(deduction).returning();
    return row;
  }

  /**
   * Writes a whole split at once.
   *
   * One statement rather than a loop: a common-area charge that half-applied
   * would leave some of a house charged and some not, and the shares no longer
   * adding up to the charge.
   */
  async createDepositDeductions(
    deductions: (InsertDepositDeduction & DepositDeductionOwnedFields)[],
  ): Promise<DepositDeduction[]> {
    if (deductions.length === 0) return [];
    return await db.insert(depositDeductions).values(deductions).returning();
  }

  async updateDepositDeduction(id: string, data: Partial<InsertDepositDeduction>): Promise<DepositDeduction> {
    const [row] = await db
      .update(depositDeductions)
      .set({ ...filterUndefined(data), updatedAt: new Date() })
      .where(eq(depositDeductions.id, id))
      .returning();
    return row;
  }

  async deleteDepositDeduction(id: string): Promise<void> {
    await db.delete(depositDeductions).where(eq(depositDeductions.id, id));
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

  // Request threads Implementation
  async getMaintenanceRequestComments(requestId: string): Promise<MaintenanceRequestComment[]> {
    return await db
      .select()
      .from(maintenanceRequestComments)
      .where(eq(maintenanceRequestComments.requestId, requestId))
      .orderBy(asc(maintenanceRequestComments.createdAt));
  }

  async getMaintenanceRequestComment(id: string): Promise<MaintenanceRequestComment | undefined> {
    const [row] = await db.select().from(maintenanceRequestComments).where(eq(maintenanceRequestComments.id, id));
    return row;
  }

  async createMaintenanceRequestComment(
    comment: InsertMaintenanceRequestComment & {
      requestId: string;
      authorUserId: string | null;
      authorEmail: string | null;
      authorName: string | null;
    },
  ): Promise<MaintenanceRequestComment> {
    const [row] = await db.insert(maintenanceRequestComments).values(comment).returning();
    return row;
  }

  async deleteMaintenanceRequestComment(id: string): Promise<string[]> {
    const deleted = await db
      .delete(maintenanceRequestComments)
      .where(eq(maintenanceRequestComments.id, id))
      .returning({ url: maintenanceRequestComments.attachmentUrl });
    return fileUrls(deleted);
  }

  // Bids Implementation
  async getMaintenanceRequestBids(requestId: string): Promise<MaintenanceRequestBid[]> {
    return await db
      .select()
      .from(maintenanceRequestBids)
      .where(eq(maintenanceRequestBids.requestId, requestId))
      .orderBy(asc(maintenanceRequestBids.createdAt));
  }

  async getMaintenanceRequestBid(id: string): Promise<MaintenanceRequestBid | undefined> {
    const [row] = await db.select().from(maintenanceRequestBids).where(eq(maintenanceRequestBids.id, id));
    return row;
  }

  async createMaintenanceRequestBid(bid: InsertMaintenanceRequestBid & { requestId: string }): Promise<MaintenanceRequestBid> {
    const [row] = await db.insert(maintenanceRequestBids).values(bid).returning();
    return row;
  }

  async updateMaintenanceRequestBid(id: string, data: Partial<InsertMaintenanceRequestBid>): Promise<MaintenanceRequestBid> {
    const [row] = await db
      .update(maintenanceRequestBids)
      .set(filterUndefined(data))
      .where(eq(maintenanceRequestBids.id, id))
      .returning();
    return row;
  }

  async deleteMaintenanceRequestBid(id: string): Promise<string[]> {
    const deleted = await db
      .delete(maintenanceRequestBids)
      .where(eq(maintenanceRequestBids.id, id))
      .returning({ url: maintenanceRequestBids.documentUrl });
    return fileUrls(deleted);
  }

  async acceptMaintenanceRequestBid(requestId: string, bidId: string): Promise<MaintenanceRequestBid | undefined> {
    return await db.transaction(async (tx) => {
      await tx
        .update(maintenanceRequestBids)
        .set({ accepted: false })
        .where(eq(maintenanceRequestBids.requestId, requestId));
      const [row] = await tx
        .update(maintenanceRequestBids)
        .set({ accepted: true })
        .where(and(eq(maintenanceRequestBids.id, bidId), eq(maintenanceRequestBids.requestId, requestId)))
        .returning();
      return row;
    });
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
    const [requests, requestPhotos, comments, bids, walkthrough, asset, billing, property, moveOut] = await Promise.all([
      db.select().from(maintenanceRequests).where(eq(maintenanceRequests.photoUrl, url)),
      db.select().from(maintenanceRequestPhotos).where(eq(maintenanceRequestPhotos.imageUrl, url)),
      db.select().from(maintenanceRequestComments).where(eq(maintenanceRequestComments.attachmentUrl, url)),
      db.select().from(maintenanceRequestBids).where(eq(maintenanceRequestBids.documentUrl, url)),
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
      db.select().from(moveOutPhotos).where(eq(moveOutPhotos.imageUrl, url)),
    ]);

    return [
      ...requests.map((record) => ({ kind: "maintenanceRequest" as const, record })),
      ...requestPhotos.map((record) => ({ kind: "maintenanceRequestPhoto" as const, record })),
      ...comments.map((record) => ({ kind: "maintenanceRequestComment" as const, record })),
      ...bids.map((record) => ({ kind: "maintenanceRequestBid" as const, record })),
      ...walkthrough.map((record) => ({ kind: "walkthroughPhoto" as const, record })),
      ...asset.map((record) => ({ kind: "assetPhoto" as const, record })),
      ...billing.map((record) => ({ kind: "billingRecord" as const, record })),
      ...property.map((record) => ({ kind: "property" as const, record })),
      ...moveOut.map((record) => ({ kind: "moveOutPhoto" as const, record })),
    ];
  }
}

/** The non-empty URLs out of a set of selected `{ url }` rows. */
function fileUrls(rows: { url: string | null }[]): string[] {
  return rows.map((row) => row.url).filter((url): url is string => !!url);
}

export const storage = new DatabaseStorage();

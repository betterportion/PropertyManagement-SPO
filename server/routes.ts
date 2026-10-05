import type { Express, RequestHandler, Response } from "express";
import { createServer, type Server } from "http";
import { storage, type PropertyDeleteBlockers } from "./storage";
import { setupAuth, isAuthenticated, getUserId } from "./auth";
import {
  loadAuthContext,
  requireActiveUser,
  requirePermission,
  hasPermission,
  requireStaff,
  requireAdmin,
  requireRegion,
  requireRegionMove,
  requireMaintenanceRequestAccess,
  canReadMaintenanceRequest,
  canReadComment,
  canPostComment,
  canDeleteComment,
  residentHouse,
  residentHouseAddress,
  rosterRowSpeaksFor,
  isCurrentRosterMember,
  canReadUpload,
  filterByRegion,
  filterByRelatedRegion,
  canSeeTask,
  requireWalkthroughPermission,
  requireWalkthroughAccess,
  requireCurrentWalkthrough,
  visibleWalkthroughs,
  canSeeActionItemSource,
  type AuthContext,
  type PermissionName,
} from "./authz";
import { z } from "zod";
import Papa from "papaparse";
import { sendError, logError, HttpError } from "./errors";
import { permissionsAfterRoleChange } from "./roleChange";
import { recordAuditEvent, auditLookup, changedFields, accountName, AUDIT_ACTIONS } from "./audit";
import { AUDIT_ACTION_VALUES } from "@shared/audit";
import multer from "multer";
import path from "path";
import { fileTypeFromBuffer } from "file-type";
import AdmZip from "adm-zip";
import {
  generateStorageKey,
  isSafeStorageKey,
  putUpload,
  uploadExists,
  removeUpload,
  openUploadStream,
  createUploadSignedUrl,
  contentTypeFor,
} from "./objectStorage";
import {
  guardedUpload,
  IMAGE_UPLOAD_MAX_BYTES,
  DOCUMENT_UPLOAD_MAX_BYTES,
  CSV_IMPORT_MAX_BYTES,
} from "./uploadLimits";
import { uploadRateLimit } from "./security";
import { removeDeletedRecordFiles } from "./uploadCleanup";
import {
  insertMaintenanceRequestSchema,
  insertWalkthroughRoomSchema,
  insertWalkthroughSchema,
  insertWalkthroughItemSchema,
  insertWalkthroughTemplateRoomSchema,
  insertWalkthroughTemplateItemSchema,
  insertWalkthroughPhotoSchema,
  insertAssetSchema,
  type AssetListRow,
  insertAssetPhotoSchema,
  insertMaintenanceContactSchema,
  insertContactNoteSchema,
  insertInvoiceSchema,
  insertBillingRecordSchema,
  insertPropertySchema,
  insertUserSchema,
  insertMaintenanceScheduleSchema,
  insertResidentSchema,
  insertRentPaymentSchema,
  RENT_PERIOD_PATTERN,
  insertSecurityDepositSchema,
  insertDepositDeductionSchema,
  financeText,
  insertTaskSchema,
  insertResourceLinkSchema,
  insertResidentDocumentSchema,
  insertPropertyBudgetSchema,
  insertRepairBudgetSchema,
  insertMoveOutChecklistSchema,
  setPropertySetupItemSchema,
  setPropertyFactsSchema,
  type InsertPropertyWithAddress,
  insertMaintenanceRequestCommentSchema,
  insertMaintenanceRequestBidSchema,
  bidNamesAVendor,
  isProjectType,
  isWholeCents,
  WHOLE_CENTS_MESSAGE,
  type InsertMaintenanceRequest,
  type MaintenanceRequest,
  type MaintenanceRequestComment,
  type User,
  WALKTHROUGH_CONDITION_LABEL,
  UPLOAD_URL_PATTERN,
} from "@shared/schema";
import { hubSlotProblem } from "@shared/resourceHubSlots";
import { STANDARD_SCHEDULE_TEMPLATES, addMonths } from "./schedules";
import { planHouseFacts } from "./houseFacts";
import { buildActionItems } from "./actionItems";
import { closedDateChange } from "./maintenanceStatus";
import { commentBodyFromClient } from "./comments";
import { planFromTemplate, planFromPreviousWalkthrough, templateRoomItems } from "./walkthroughTemplate";
import { parseResidentCsv, buildImportPreview, checkImportRow } from "./residentImport";
import { SETUP_ITEMS, setupItemsFor } from "@shared/propertySetup";
import { RESIDENT_DOCUMENTS, isKnownResidentDocument } from "@shared/residentDocuments";
import { buildRegionSummaries, type RegionStaff } from "./regionSummary";
import { fromCents, returnedExceedsHeld, splitEvenly, toCents } from "@shared/depositLedger";
import { hasBegunEverywhere } from "@shared/dueDates";
import { fiscalYearLabel } from "@shared/fiscalYear";
import { HOUSE_PORTAL_ACCOUNT_LIMIT, isCurrentResident } from "@shared/residents";
import { closeDepartedHouseholdLogins } from "./householdLogins";
import { MAX_SNOOZE_DAYS, MAX_SNOOZE_MONTHS } from "@shared/assetLifecycle";
import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { contractorLoad, recurringIssues } from "./aggregates";
import { onEmailOutcome, sendEmail, type OutboundEmail } from "./email";
import { commentEmail, householdEmail, maintenanceReceivedEmail, maintenanceStatusEmail } from "./notifications";
import { commentRecipients, submitterMayRead, type CommentCandidate } from "./commentRecipients";
import { readAppUrlFromEnv, readQuickBooksConfigFromEnv } from "./config";
import { quickBooksHealth, runQuickBooksSync, withQuickBooks } from "./quickbooksSync";
import { createQuickBooksApi, QuickBooksConnectionLostError, QuickBooksRequestError } from "./quickbooks/api";
import { decryptToken, encryptToken } from "./quickbooks/crypto";
import { isQuickBooksStale } from "@shared/quickbooks";
import { rosterSyncHealth, runRosterSync, runScheduledRosterSync } from "./rosterSheetSync";
import { emailHealth, summarizeEmailLog } from "./emailLog";
import { readEmailConfigFromEnv } from "./config";
import { readRosterSheetConfigFromEnv } from "./config";
import { ROSTER_SHEET_COLUMNS } from "@shared/rosterSheet";
import { log } from "./logger";
import { normalizeRegion, normalizeRegions } from "./migrateRegions";
import { REGIONS } from "@shared/regions";
import { fieldsNotForResident } from "@shared/permissions";

// Uploads are buffered in memory only long enough to be written to App Storage.
// Nothing is written to the container filesystem, because autoscale rebuilds it
// on every publish and runs more than one instance. See server/objectStorage.ts.
const fileStorage = multer.memoryStorage();

const upload = multer({
  storage: fileStorage,
  // `fields: 0` matters as much as the size limit: without it a request could
  // carry one legal-sized file plus any number of text fields, which are also
  // buffered in memory but would not be counted against the in-flight ceiling.
  // The uploader only ever sends the file itself.
  limits: { fileSize: IMAGE_UPLOAD_MAX_BYTES, files: 1, fields: 0 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error("Only image files are allowed"));
  },
});

/**
 * The body of a confirmed roster import.
 *
 * Deliberately not the preview object the client was handed: only the fields
 * that become a resident are accepted, so a client cannot smuggle a region, a
 * property or an `isActive` past the route by echoing the preview back.
 */
const rosterImportSchema = z.object({
  rows: z.array(z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().nullish().transform((v) => v ?? null),
    roomName: z.string().nullish().transform((v) => v ?? null),
    notes: z.string().nullish().transform((v) => v ?? null),
    moveInDate: z.string().nullish().transform((v) => v ?? null),
  })).min(1, "There is nothing to import"),
});

const roleUpdateSchema = z.object({
  role: z.enum(["admin", "regional_administrator", "resident"]),
});

const statusUpdateSchema = z.object({
  isActive: z.boolean(),
});

const notificationsUpdateSchema = z.object({
  commentEmailsEnabled: z.boolean(),
});

const permissionsUpdateSchema = z.object({
  canViewMaintenance: z.boolean().optional(),
  canManageMaintenance: z.boolean().optional(),
  canViewWalkthroughs: z.boolean().optional(),
  canManageWalkthroughs: z.boolean().optional(),
  canViewAssets: z.boolean().optional(),
  canManageAssets: z.boolean().optional(),
  canViewBilling: z.boolean().optional(),
  canManageBilling: z.boolean().optional(),
  canViewContacts: z.boolean().optional(),
  canManageContacts: z.boolean().optional(),
  canManageUsers: z.boolean().optional(),
  canViewProperties: z.boolean().optional(),
  canManageProperties: z.boolean().optional(),
  canViewFinancials: z.boolean().optional(),
  canManageFinancials: z.boolean().optional(),
  canCompleteWalkthroughs: z.boolean().optional(),
  canManagePropertySetup: z.boolean().optional(),
  canViewResourceHub: z.boolean().optional(),
  allowedRegions: z.array(z.string()).optional(),
});

/** How many activity rows one request may ask for, and how many it gets by default. */
const AUDIT_LOG_MAX_PAGE_SIZE = 100;
const AUDIT_LOG_DEFAULT_PAGE_SIZE = 25;

/** An absent filter and an empty one mean the same thing to the page. */
const blankAsAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/** A calendar day, read as UTC so the boundary does not move with the reader. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date as YYYY-MM-DD");

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

/** Midnight beginning the given day. */
function startOfUtcDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Midnight ending the given day, i.e. the start of the day after it. */
function nextUtcDay(day: string): Date {
  return new Date(startOfUtcDay(day).getTime() + ONE_DAY_MS);
}

/**
 * One end of an activity-log range: a calendar day, read as UTC, or an exact
 * instant. The activity page sends instants -- the reader's own local
 * midnights -- because a UTC day starts at 7pm Central the evening before, and
 * the list shows local times. The bare day stays for anyone reading the API by
 * hand. A day at the end of a range is meant inclusively, so it becomes the
 * following midnight; an instant already is that midnight. The storage layer
 * treats the end as exclusive.
 */
const rangeBound = (dayToDate: (day: string) => Date) =>
  z
    .string()
    .refine(
      (value) => isoDate.safeParse(value).success || z.string().datetime().safeParse(value).success,
      "Expected a date as YYYY-MM-DD or an ISO timestamp",
    )
    .transform((value) => (isoDate.safeParse(value).success ? dayToDate(value) : new Date(value)));

/**
 * Filters for the activity page. Everything is optional except the bounds on
 * the page size, which are not negotiable: the audit table only ever grows, so
 * a request must never be able to ask for all of it.
 */
const auditLogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(AUDIT_LOG_MAX_PAGE_SIZE)
    .default(AUDIT_LOG_DEFAULT_PAGE_SIZE),
  /** Part of an email address, matched against the actor as it was recorded. */
  actor: blankAsAbsent(z.string().trim().max(320)),
  action: blankAsAbsent(z.enum(AUDIT_ACTION_VALUES as [string, ...string[]])),
  from: blankAsAbsent(rangeBound(startOfUtcDay)),
  to: blankAsAbsent(rangeBound(nextUtcDay)),
});

/**
 * Where a walkthrough room sits: its walkthrough's region, house and property.
 * Read off the walkthrough, never off a request body or the room's loose
 * propertyId, either of which a hand-made request could name freely. A legacy
 * room with no walkthrough falls back to its property. Undefined when the
 * room, its walkthrough or its property is missing -- the caller refuses.
 */
async function roomScope(
  roomId: string | null | undefined,
): Promise<{ region: string; buildingAddress: string; propertyId: string } | undefined> {
  const room = roomId ? await storage.getWalkthroughRoom(roomId) : undefined;
  if (!room) return undefined;
  return walkthroughScope(room.walkthroughId, room.propertyId);
}

async function walkthroughScope(
  walkthroughId: string | null | undefined,
  legacyPropertyId?: string | null,
): Promise<{ region: string; buildingAddress: string; propertyId: string } | undefined> {
  if (walkthroughId) {
    const walkthrough = await storage.getWalkthrough(walkthroughId);
    return walkthrough && { region: walkthrough.region, buildingAddress: walkthrough.buildingAddress, propertyId: walkthrough.propertyId };
  }
  const property = legacyPropertyId ? await storage.getProperty(legacyPropertyId) : undefined;
  return property && { region: property.region, buildingAddress: property.address, propertyId: property.id };
}

/**
 * Shared guard for linking and unlinking a vendor contact on a maintenance
 * request. Both sides of the relationship are checked: it is not enough to
 * reach the request if the contact belongs to another region, because linking
 * exposes that contact's details to everyone who can read the request.
 *
 * Returns false having already sent a response when access is denied.
 */
async function resolveContactLink(
  res: import("express").Response,
  ctx: AuthContext,
  requestId: string,
  contactId: string,
): Promise<boolean> {
  const request = await storage.getMaintenanceRequest(requestId);
  if (!request) {
    res.status(404).json({ message: "Maintenance request not found" });
    return false;
  }
  if (!requireRegion(res, ctx, request.region)) return false;

  const contact = await storage.getMaintenanceContact(contactId);
  if (!contact) {
    res.status(404).json({ message: "Contact not found" });
    return false;
  }
  if (!requireRegion(res, ctx, contact.region)) return false;

  return true;
}

/**
 * Why a request write's project fields are wrong, or null when they are fine.
 *
 * Two rules. A repair carries none of them: a contract link, a cost or a
 * target period on a `request`-type row is refused rather than stored and
 * hidden, so "null on repairs" is true by construction. And a quarter needs
 * a year -- checked over the stored row too, because an edit sends only the
 * field it changes and the year may already be there.
 */
const PROJECT_FIELDS = ["contractUrl", "estimatedCost", "actualCost", "targetYear", "targetQuarter"] as const;

/** What a repair holds in every project field. */
const CLEARED_PROJECT_FIELDS = { contractUrl: null, estimatedCost: null, actualCost: null, targetYear: null, targetQuarter: null };

const NOT_A_HOUSE_MESSAGE = "Choose one of the portal's houses for this request.";

const RETURNED_OVER_HELD = "The amount returned cannot be more than the amount held.";

/**
 * Why a house cannot be deleted yet, naming what it still holds, or undefined
 * when nothing stands in the way.
 */
function propertyDeleteRefusal(name: string, left: PropertyDeleteBlockers): string | undefined {
  const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    left.residents > 0 && `${counted(left.residents, "resident", "residents")} on its roster (moved-out residents count)`,
    left.hhFees > 0 && counted(left.hhFees, "HH fee record", "HH fee records"),
    left.deposits > 0 && counted(left.deposits, "deposit", "deposits"),
    left.deductions > 0 && counted(left.deductions, "deposit deduction", "deposit deductions"),
  ].filter((part): part is string => typeof part === "string");
  if (parts.length === 0) return undefined;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `${name} can't be deleted: it still has ${list}. Deleting the house would erase them.`;
}

function projectFieldsProblem(
  nextType: string,
  patch: Partial<InsertMaintenanceRequest>,
  existing?: MaintenanceRequest,
): string | null {
  if (!isProjectType(nextType)) {
    // A null is what a repair holds anyway; a value is the thing refused.
    return PROJECT_FIELDS.some((field) => patch[field] != null)
      ? "Only projects and capital projects carry a contract link, costs or a target period"
      : null;
  }
  const targetYear = patch.targetYear !== undefined ? patch.targetYear : existing?.targetYear;
  const targetQuarter = patch.targetQuarter !== undefined ? patch.targetQuarter : existing?.targetQuarter;
  return targetQuarter != null && targetYear == null ? "A quarter needs a year to go with it" : null;
}

export async function registerRoutes(app: Express): Promise<Server> {
  await setupAuth(app);

  // Every automated send's outcome goes to the email log (Settings → Email
  // health). Registered here, before any route or job can send.
  onEmailOutcome((record) => storage.createEmailLogEntry(record));

  app.get('/api/auth/user', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // This is the one endpoint a deactivated user may still reach, so the
      // client can tell them their account is inactive instead of failing with
      // an unexplained error on every other request. Their permissions are
      // withheld, because the UI builds its navigation from them and every
      // other endpoint will reject them anyway.
      if (!user.isActive) {
        return res.json({ ...user, permissions: undefined });
      }

      const permissions = await storage.getUserPermissions(userId);
      res.json({ ...user, permissions });
    } catch (error) {
      sendError(res, error, "Failed to fetch user");
    }
  });

  // The comment email off switch, flipped for oneself. Any active account,
  // on either tier: silencing email is not a grant. A preference rather than
  // access, money or a document, so nothing is audited.
  app.patch('/api/auth/me/notifications', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;

      const { commentEmailsEnabled } = notificationsUpdateSchema.parse(req.body);
      const user = await storage.updateUserCommentEmails(ctx.userId, commentEmailsEnabled);
      res.json(user);
    } catch (error) {
      sendError(res, error, "Failed to update your email settings");
    }
  });

  app.get('/api/users', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      sendError(res, error, "Failed to fetch users");
    }
  });

  app.patch('/api/users/:id/role', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const validatedData = roleUpdateSchema.parse(req.body);
      // Looked up for real, not through auditLookup: the previous role decides
      // what the permissions row becomes, and user.role_changed is kept
      // indefinitely, so an event about an account that does not exist would
      // sit in the log for good.
      const previous = await storage.getUser(req.params.id);
      if (!previous) {
        return res.status(404).json({ message: "User not found" });
      }
      // The Settings select never sends the current role, but the API can; a
      // no-op must not reset the row the way the old code did.
      if (previous.role === validatedData.role) return res.json(previous);

      const nextPermissions = permissionsAfterRoleChange(req.params.id, previous.role, validatedData.role);
      const existingPermissions = nextPermissions ? await storage.getUserPermissions(req.params.id) : undefined;
      const user = await storage.updateUserRole(req.params.id, validatedData.role, nextPermissions);

      const who = accountName(previous);
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
        entityType: "user",
        entityId: req.params.id,
        summary: `Changed ${who} from ${previous.role} to ${validatedData.role}`,
        details: { from: previous.role, to: validatedData.role },
      });
      // The reset is a permissions change in its own right, and the access
      // history has to show it, not only the role that caused it.
      if (nextPermissions) {
        recordAuditEvent(ctx, {
          action: AUDIT_ACTIONS.USER_PERMISSIONS_CHANGED,
          entityType: "user",
          entityId: req.params.id,
          summary: `Reset permissions for ${who} on a role change to ${validatedData.role}`,
          details: {
            changed: changedFields(existingPermissions as Record<string, unknown> | undefined, nextPermissions),
            allowedRegions: nextPermissions.allowedRegions ?? [],
          },
        });
      }

      res.json(user);
    } catch (error) {
      sendError(res, error, "Failed to update user role");
    }
  });

  app.patch('/api/users/:id/status', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const { isActive } = statusUpdateSchema.parse(req.body);
      // Looked up for real, not through auditLookup: user.status_changed is
      // kept indefinitely, and an event about an account that does not exist
      // would sit in the log for good.
      const previous = await storage.getUser(req.params.id);
      if (!previous) {
        return res.status(404).json({ message: "User not found" });
      }
      const user = await storage.updateUserActiveStatus(req.params.id, isActive);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.USER_STATUS_CHANGED,
        entityType: "user",
        entityId: req.params.id,
        summary: `${isActive ? "Reactivated" : "Deactivated"} ${accountName(previous)}`,
        details: { isActive },
      });

      res.json(user);
    } catch (error) {
      sendError(res, error, "Failed to update user status");
    }
  });

  // The same switch, flipped for somebody else: a leader who tells their RA
  // "stop emailing me" gets what they asked for. Admin-only, like every
  // other change to an account.
  app.patch('/api/users/:id/notifications', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const { commentEmailsEnabled } = notificationsUpdateSchema.parse(req.body);
      const user = await storage.updateUserCommentEmails(req.params.id, commentEmailsEnabled);
      res.json(user);
    } catch (error) {
      sendError(res, error, "Failed to update the account's email settings");
    }
  });

  // Which house a resident login belongs to — and therefore which house's
  // maintenance history it can see. Admin-only, like every account change.
  app.patch('/api/users/:id/property', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const { propertyId } = z.object({ propertyId: z.string().nullable() }).parse(req.body);

      const target = await storage.getUser(req.params.id);
      if (!target) {
        return res.status(404).json({ message: "User not found" });
      }
      if (target.role !== "resident") {
        return res.status(400).json({
          message: "Only resident accounts link to a house. Change the role first.",
        });
      }

      let property = null;
      if (propertyId !== null) {
        property = await storage.getProperty(propertyId);
        if (!property) {
          return res.status(404).json({ message: "Property not found" });
        }
      }

      const user = await storage.updateUserProperty(req.params.id, propertyId);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.USER_PROPERTY_CHANGED,
        entityType: "user",
        entityId: req.params.id,
        summary: property
          ? `Linked ${accountName(target)} to ${property.name}`
          : `Unlinked ${accountName(target)} from their house`,
        details: { from: target.propertyId ?? null, to: propertyId },
      });

      res.json(user);
    } catch (error) {
      sendError(res, error, "Failed to update the account's house");
    }
  });

  app.get('/api/users/:id/permissions', isAuthenticated, async (req: any, res) => {
    try {
      // A user may read only their own permissions. Admins may read anyone's.
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!ctx.isAdmin && req.params.id !== ctx.userId) {
        return res.status(403).json({ message: "Forbidden" });
      }
      // No row is normal -- admins frequently have none -- so it answers null
      // rather than a 404 that every staff page would log as an error.
      const permissions = await storage.getUserPermissions(req.params.id);
      res.json(permissions ?? null);
    } catch (error) {
      sendError(res, error, "Failed to fetch permissions");
    }
  });

  app.patch('/api/users/:id/permissions', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const validatedData = permissionsUpdateSchema.parse(req.body);
      const filteredData = Object.fromEntries(
        Object.entries(validatedData).filter(([_, v]) => v !== undefined)
      );

      // A resident's row holds only resident grants: a staff flag or a region
      // on it would be one missed staff check away from a region path.
      const target = await storage.getUser(req.params.id);
      if (!target) {
        return res.status(404).json({ message: "User not found" });
      }
      if (target.role === "resident" && fieldsNotForResident(filteredData).length > 0) {
        return res.status(400).json({
          message:
            "A resident account can only be allowed to view maintenance, complete walkthroughs and see the Resources page. Staff permissions and regions are for staff accounts.",
        });
      }

      const existingPermissions = await auditLookup(() => storage.getUserPermissions(req.params.id));
      const permissions = await storage.upsertUserPermissions({
        userId: req.params.id,
        ...filteredData,
      });

      // Field names and the region list only. A permissions row is all
      // booleans plus regions, so this is the whole change without storing a
      // copy of the request. The account is named by email, never by its id:
      // the id is the sign-in provider's subject, which nobody can read.
      const who = accountName(target);
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.USER_PERMISSIONS_CHANGED,
        entityType: "user",
        entityId: req.params.id,
        summary: `Changed permissions for ${who}`,
        details: {
          changed: changedFields(existingPermissions as Record<string, unknown> | undefined, filteredData),
          allowedRegions: filteredData.allowedRegions ?? existingPermissions?.allowedRegions ?? [],
        },
      });

      res.json(permissions);
    } catch (error) {
      sendError(res, error, "Failed to update permissions");
    }
  });

  app.post('/api/users', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const validatedData = insertUserSchema.parse(req.body);
      // upsertUser conflict-updates role, house and active status on an id
      // that exists, without the permissions reset or the role-change event
      // the role route gives. An existing account is changed through those
      // routes, so an id that is already taken is refused before any write.
      const requestedId: string | undefined = req.body.id || undefined;
      if (requestedId && (await storage.getUser(requestedId))) {
        return res.status(409).json({
          message:
            "An account with that ID already exists. To change its role or house, use the settings for that account instead.",
        });
      }
      const { user, relinkedFrom } = await storage.upsertUser({
        id: requestedId,
        ...validatedData,
      });

      // An email that already had an account moves that account to the new id
      // rather than creating one, so the trail says so, as a sign-in re-link does.
      recordAuditEvent(
        ctx,
        relinkedFrom
          ? {
              action: AUDIT_ACTIONS.USER_RELINKED,
              entityType: "user",
              entityId: user.id,
              summary: `Linked the ${relinkedFrom.role} account for ${relinkedFrom.email} to a new sign-in ID`,
              details: { previousUserId: relinkedFrom.id, role: relinkedFrom.role },
            }
          : {
              action: AUDIT_ACTIONS.USER_CREATED,
              entityType: "user",
              entityId: user.id,
              summary: `Created account ${accountName(user)} with role ${user.role ?? "resident"}`,
              details: { role: user.role ?? null, isActive: user.isActive ?? null },
            },
      );

      res.json(user);
    } catch (error) {
      sendError(res, error, "Failed to create user");
    }
  });

  app.delete('/api/users/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const previous = await auditLookup(() => storage.getUser(req.params.id));
      await storage.deleteUser(req.params.id);

      // Written after the deletion, and with no foreign key to the row that is
      // now gone -- this is the event most likely to be asked about later.
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.USER_DELETED,
        entityType: "user",
        entityId: req.params.id,
        summary: previous ? `Deleted account ${accountName(previous)}` : "Deleted an account that could not be looked up",
        details: { role: previous?.role ?? null },
      });

      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete user");
    }
  });

  /**
   * The activity trail, for the Settings page.
   *
   * Administrators only, and deliberately not opened up to regional
   * administrators: the trail names who did what across every region, so it is
   * not something to scope by region -- it is something to withhold.
   *
   * Always a page. The table grows for the life of the portal and there is no
   * request that should be able to ask for the whole of it.
   */
  app.get('/api/audit-log', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const { page, pageSize, actor, action, from, to } = auditLogQuerySchema.parse(req.query);

      const { events, total } = await storage.listAuditEvents({
        actorEmail: actor,
        action,
        from,
        to,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });

      res.json({ events, total, page, pageSize });
    } catch (error) {
      sendError(res, error, "Failed to fetch the activity log");
    }
  });

  /**
   * Fires an outbound email without letting it touch the request.
   *
   * `sendEmail` never throws and email being unconfigured is a normal state,
   * so the only thing left to get wrong is awaiting it: eight round trips to a
   * mail provider should not hold a response open, and an acknowledgement is a
   * courtesy attached to something that has already happened.
   */
  function notify(message: OutboundEmail | null) {
    if (message) void sendEmail(message);
  }

  /**
   * The accounts, with their permissions, and the house each resident login
   * belongs to -- what any "may this account read this request?" decision
   * about somebody who is not the caller needs. Three queries, never one per
   * person. A login gets its house only while a current roster row there
   * speaks for it, the same house rule as every read.
   */
  async function loadAccountsAndHouses(): Promise<{
    candidates: CommentCandidate[];
    houseAddressOf: (user: User) => string | undefined;
  }> {
    const [candidates, properties, roster] = await Promise.all([
      storage.getAllUsersWithPermissions(),
      storage.getAllProperties(),
      storage.getAllResidents(),
    ]);
    const addressById = new Map(properties.map((property) => [property.id, property.address]));
    return {
      candidates,
      houseAddressOf: (user) =>
        user.propertyId && roster.some((row) => isCurrentRosterMember(row, user))
          ? addressById.get(user.propertyId)
          : undefined,
    };
  }

  /**
   * Emails the person a request names as its submitter -- the acknowledgement
   * on filing, the note on a status change -- but only while that account may
   * still read the request (#290), the same rule the comment email applies.
   * `build` is the pure message builder. A failure working out the recipient
   * is logged and sends nothing: fail closed, and never fail the request.
   */
  async function emailSubmitter(
    request: MaintenanceRequest,
    build: (request: MaintenanceRequest) => OutboundEmail | null,
  ): Promise<void> {
    try {
      const message = build(request);
      if (!message) return;
      if (!submitterMayRead({ request, ...(await loadAccountsAndHouses()) })) return;
      notify(message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`submitter email skipped for request ${request.id}: ${detail}`, "email");
    }
  }

  /**
   * Emails the people who can see a comment that was just posted.
   *
   * Who they are is one pure function (commentRecipients.ts) over the whole
   * account list, the thread so far and the houses those accounts are linked
   * to -- three queries, never one per person. The sends go through notify,
   * unawaited, one message per person. Nothing in here may fail the comment:
   * it is already saved by the time this runs, so a failure working out who
   * to write to is logged and the caller answers 201 regardless.
   */
  async function emailThreadAbout(request: MaintenanceRequest, comment: MaintenanceRequestComment): Promise<void> {
    try {
      const [{ candidates, houseAddressOf }, thread] = await Promise.all([
        loadAccountsAndHouses(),
        storage.getMaintenanceRequestComments(request.id),
      ]);
      const recipients = commentRecipients({
        request,
        comment,
        candidates,
        participantIds: thread.map((entry) => entry.authorUserId),
        houseAddressOf,
      });
      const appUrl = readAppUrlFromEnv().url;
      for (const { email } of recipients) {
        notify(commentEmail({ to: email, request, comment, appUrl }));
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`comment email skipped for request ${request.id}: ${detail}`, "email");
    }
  }

  // Maintenance Requests Routes
  app.get('/api/maintenance-requests', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requirePermission(res, ctx, "canViewMaintenance", "canManageMaintenance")) return;

      const requests = await storage.getAllMaintenanceRequests();

      // One rule, applied to the list and to the detail route alike, so the two
      // can never disagree about what a user is allowed to see. The caller's
      // house is resolved once for the whole list, not once per row.
      const residentHouse = await residentHouseAddress(ctx);
      const filteredRequests = requests.filter((request) =>
        canReadMaintenanceRequest(ctx, request, residentHouse),
      );
      res.json(filteredRequests);
    } catch (error) {
      sendError(res, error, "Failed to fetch maintenance requests");
    }
  });

  /**
   * The room names to offer when somebody says where a problem is.
   *
   * Free text alone will not group "living room" and "Living Rm", which
   * defeats the point -- the point being to notice that these blinds have
   * broken every year since we started renting this house. So the suggestions
   * come from the house's own walkthrough rooms, and free text stays available
   * as the fallback for anything the checklist has no word for.
   *
   * A resident's house is taken from their account and the query parameter is
   * ignored outright. Honouring it would turn this into a way to enumerate
   * another house's rooms -- a second read path into walkthrough data, which
   * is the exact shape of both historic authorization gaps in this codebase.
   */
  app.get('/api/maintenance-locations', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requirePermission(res, ctx, "canViewMaintenance", "canManageMaintenance")) return;

      let buildingAddress: string | null;

      if (ctx.isResident) {
        buildingAddress = await residentHouseAddress(ctx);
        // No house claim means no suggestions -- and the free-text field still
        // works, which is the fallback this whole feature is built around.
        if (!buildingAddress) return res.json([]);
      } else {
        const property = await storage.getProperty(String(req.query.propertyId ?? ""));
        if (!property) {
          return res.status(404).json({ message: "Property not found" });
        }
        if (!requireRegion(res, ctx, property.region)) return;
        buildingAddress = property.address;
      }

      const rooms = await storage.getWalkthroughRoomsByBuilding(buildingAddress);

      // One entry per room name. A house's rooms repeat across its
      // walkthroughs; its vocabulary does not.
      const names: string[] = [];
      const seen = new Set<string>();
      for (const room of rooms) {
        if (seen.has(room.name)) continue;
        seen.add(room.name);
        names.push(room.name);
      }

      res.json(names);
    } catch (error) {
      sendError(res, error, "Failed to fetch locations");
    }
  });

  app.get('/api/maintenance-requests/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requirePermission(res, ctx, "canViewMaintenance", "canManageMaintenance")) return;

      const request = await storage.getMaintenanceRequest(req.params.id);
      if (!request) {
        return res.status(404).json({ message: "Maintenance request not found" });
      }

      if (!requireMaintenanceRequestAccess(res, ctx, request, await residentHouseAddress(ctx))) return;

      res.json(request);
    } catch (error) {
      sendError(res, error, "Failed to fetch maintenance request");
    }
  });

  // Attaches already-uploaded photos to a just-created request. Only uploads the
  // caller themselves stored are attached, so a request body cannot point a
  // request at someone else's file to expose it (its visibility is inherited).
  async function attachRequestPhotos(ctx: AuthContext, requestId: string, photoUrls: unknown): Promise<void> {
    if (!Array.isArray(photoUrls)) return;
    const uploadedBy = ctx.user.email || "Unknown";
    for (const url of photoUrls.slice(0, 10)) {
      if (typeof url !== "string" || !url.startsWith("/uploads/")) continue;
      const key = url.slice("/uploads/".length);
      if (!isSafeStorageKey(key)) continue;
      const upload = await storage.getUploadByStorageKey(key);
      if (!upload || upload.uploadedBy !== ctx.userId) continue;
      await storage.createMaintenanceRequestPhoto({ requestId, imageUrl: url, uploadedBy });
    }
  }

  app.post('/api/maintenance-requests', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requirePermission(res, ctx, "canViewMaintenance", "canManageMaintenance")) return;

      // The submitter is always taken from the session, never from the request
      // body, so a caller cannot file a request in someone else's name.
      const submittedBy = ctx.user.email || "Unknown";

      if (ctx.isResident) {
        // A resident never chooses a region or a house -- they cannot even see
        // the property list. Their request is filed against the house their
        // account is linked to and a current roster row speaks for -- the same
        // house every read of their repairs resolves (residentHouse), so what
        // they file is what they and their household read back. Looking the
        // roster up by email alone would file a resident on two rosters into
        // whichever row is newest.
        const house = await residentHouse(ctx);
        if (!house) {
          return res.status(400).json({
            message:
              "We couldn't find your house on file. Ask your house director to add you to a house, then try again.",
          });
        }
        // The type is forced too: a resident files a repair and nothing else,
        // whatever the browser sends. A project is staff's to open, and a
        // resident could not read one back anyway (the type rule in authz.ts).
        const validatedData = insertMaintenanceRequestSchema
          .omit({
            region: true,
            buildingAddress: true,
            submittedBy: true,
            type: true,
            // A repair carries none of the project fields, and this is a repair.
            contractUrl: true,
            estimatedCost: true,
            actualCost: true,
            targetYear: true,
            targetQuarter: true,
            // A household reports a problem; whether it is in hand or done is
            // staff's call. Filed already closed, it would never show as open
            // work, so every resident request starts pending.
            status: true,
          })
          .parse(req.body);
        await requireOwnUploads(ctx, validatedData, ["photoUrl"]);
        const request = await storage.createMaintenanceRequest({
          ...validatedData,
          type: "request",
          status: "pending",
          region: house.region,
          buildingAddress: house.address,
          submittedBy,
        });
        await attachRequestPhotos(ctx, request.id, req.body?.photoUrls);
        // One of the things JotForm used to do that the portal should do
        // natively: without it, filing a request feels like putting a note in
        // a drawer.
        await emailSubmitter(request, maintenanceReceivedEmail);
        return res.json(request);
      }

      // Staff file into a region they can reach. submittedBy is still the
      // session, so it is omitted from the body here too.
      const parsed = insertMaintenanceRequestSchema.omit({ submittedBy: true }).parse(req.body);
      await requireOwnUploads(ctx, parsed, ["photoUrl"]);
      // The region is the house's, never the body's: a request tagged with one
      // region but filed against a house in another is hidden from that
      // house's RA while its household can still read it.
      const house = await storage.getPropertyByAddress(parsed.buildingAddress);
      if (!house) return res.status(400).json({ message: NOT_A_HOUSE_MESSAGE });
      const validatedData = { ...parsed, region: house.region };
      if (!requireRegion(res, ctx, validatedData.region, "Forbidden - Cannot create in this region")) return;
      const problem = projectFieldsProblem(validatedData.type ?? "request", validatedData);
      if (problem) return res.status(400).json({ message: problem });

      const request = await storage.createMaintenanceRequest({
        ...validatedData,
        submittedBy,
        // Staff can file a request that is already resolved. Treat that as
        // closing it now, so it carries a close date like any other.
        ...closedDateChange(undefined, validatedData.status, new Date()),
      });
      await attachRequestPhotos(ctx, request.id, req.body?.photoUrls);
      // Staff filing on somebody's behalf: the acknowledgement still goes to
      // whoever submittedBy names, which for a staff-filed request is the
      // staff member themselves.
      await emailSubmitter(request, maintenanceReceivedEmail);
      res.json(request);
    } catch (error) {
      sendError(res, error, "Failed to create maintenance request");
    }
  });

  // Photos attached to maintenance requests. A photo inherits the request's
  // visibility, so a resident sees only their own request's photos and staff are
  // bound by region -- the client groups these by requestId.
  app.get('/api/maintenance-request-photos', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      const [photos, requests, residentHouse] = await Promise.all([
        storage.getAllMaintenanceRequestPhotos(),
        storage.getAllMaintenanceRequests(),
        residentHouseAddress(ctx),
      ]);
      const byId = new Map(requests.map((r) => [r.id, r]));
      res.json(photos.filter((p) => {
        const request = byId.get(p.requestId);
        return request && canReadMaintenanceRequest(ctx, request, residentHouse);
      }));
    } catch (error) {
      sendError(res, error, "Failed to fetch request photos");
    }
  });

  app.delete('/api/maintenance-request-photos/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      const photo = await storage.getMaintenanceRequestPhoto(req.params.id);
      if (!photo) {
        return res.status(404).json({ message: "Photo not found" });
      }
      const request = await storage.getMaintenanceRequest(photo.requestId);
      if (!request || !canReadMaintenanceRequest(ctx, request, await residentHouseAddress(ctx))) {
        return res.status(403).json({ message: "Forbidden" });
      }
      // A resident may remove only photos they added; staff may remove any on a
      // request in their region, if they may manage maintenance -- reading a
      // request is not permission to take its photos off it.
      const isUploader = photo.uploadedBy === (ctx.user.email || "");
      if (ctx.isResident ? !isUploader : !hasPermission(ctx, "canManageMaintenance")) {
        return res.status(403).json({ message: "Forbidden" });
      }
      await removeDeletedRecordFiles(await storage.deleteMaintenanceRequestPhoto(req.params.id));
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete request photo");
    }
  });

  app.patch('/api/maintenance-requests/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageMaintenance")) return;

      const existingRequest = await storage.getMaintenanceRequest(req.params.id);
      if (!existingRequest) {
        return res.status(404).json({ message: "Maintenance request not found" });
      }

      const validatedData = insertMaintenanceRequestSchema.partial().parse(req.body);
      await requireOwnUploads(ctx, validatedData, ["photoUrl"], existingRequest);

      // As on create, a region follows the house. A new address must be a
      // house; an older request whose address no longer matches one keeps the
      // region it was given.
      if (validatedData.buildingAddress !== undefined || validatedData.region !== undefined) {
        const house = await storage.getPropertyByAddress(validatedData.buildingAddress ?? existingRequest.buildingAddress);
        if (house) validatedData.region = house.region;
        else if (validatedData.buildingAddress !== undefined) return res.status(400).json({ message: NOT_A_HOUSE_MESSAGE });
      }

      if (!requireRegionMove(res, ctx, existingRequest.region, validatedData.region)) return;

      const nextType = validatedData.type ?? existingRequest.type;
      const problem = projectFieldsProblem(nextType, validatedData, existingRequest);
      if (problem) return res.status(400).json({ message: problem });

      // A project turned back into a repair drops its project fields, so a
      // repair never carries a cost. Its bids stay in their table, unreachable
      // until it is a project again -- a type change is not a delete.
      const demoted = !isProjectType(nextType) && isProjectType(existingRequest.type) ? CLEARED_PROJECT_FIELDS : {};
      const writes = { ...validatedData, ...demoted };

      // Stamp or clear the close date from the transition. This is the only
      // thing that writes completedDate on an update -- it is never taken from
      // the request body, so a client cannot backdate a closure.
      const request = await storage.updateMaintenanceRequest(req.params.id, {
        ...writes,
        ...closedDateChange(existingRequest.status, validatedData.status, new Date()),
      });

      // The contract is a document link, like the lease link on a property,
      // and CLAUDE.md's standing rule is that a document changing is recorded.
      // The link itself is what somebody could follow, so the event says that
      // it changed and never to what. Costs are estimates, not money moving,
      // and are not recorded.
      if (writes.contractUrl !== undefined && writes.contractUrl !== (existingRequest.contractUrl ?? null)) {
        recordAuditEvent(ctx, {
          action: AUDIT_ACTIONS.MAINTENANCE_DOCUMENTS_CHANGED,
          entityType: "maintenance_request",
          entityId: req.params.id,
          summary: `Changed the contract link on "${existingRequest.title}" (${existingRequest.buildingAddress})`,
          details: { field: "contractUrl", cleared: writes.contractUrl === null, region: existingRequest.region },
        });
      }

      // Only a status change is recorded. Every other edit is ordinary work,
      // and logging all of them would bury the ones that matter.
      if (validatedData.status && validatedData.status !== existingRequest.status) {
        recordAuditEvent(ctx, {
          action: AUDIT_ACTIONS.MAINTENANCE_STATUS_CHANGED,
          entityType: "maintenance_request",
          entityId: req.params.id,
          summary: `Moved "${existingRequest.title}" from ${existingRequest.status} to ${validatedData.status}`,
          details: { from: existingRequest.status, to: validatedData.status },
        });

        // Same condition as the audit event, deliberately: an edit to a
        // description must not email anybody about nothing.
        await emailSubmitter(request, (updated) => maintenanceStatusEmail(updated, existingRequest.status));
      }

      res.json(request);
    } catch (error) {
      sendError(res, error, "Failed to update maintenance request");
    }
  });

  app.delete('/api/maintenance-requests/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageMaintenance")) return;

      const existingRequest = await storage.getMaintenanceRequest(req.params.id);
      if (!existingRequest) {
        return res.status(404).json({ message: "Maintenance request not found" });
      }

      if (!requireRegion(res, ctx, existingRequest.region)) return;

      await removeDeletedRecordFiles(await storage.deleteMaintenanceRequest(req.params.id));
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete maintenance request");
    }
  });

  // Linked Contacts for a Maintenance Request
  app.get('/api/maintenance-requests/:id/contacts', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requirePermission(res, ctx, "canViewMaintenance", "canManageMaintenance")) return;

      const request = await storage.getMaintenanceRequest(req.params.id);
      if (!request) {
        return res.status(404).json({ message: "Maintenance request not found" });
      }

      // Vendor contact details are only reachable through a request the caller
      // is already allowed to read: residents through their own house,
      // staff through region. Previously any signed-in user could read the
      // contacts on any request by guessing its ID.
      if (!requireMaintenanceRequestAccess(res, ctx, request, await residentHouseAddress(ctx))) return;

      const contacts = await storage.getRequestContacts(req.params.id);
      res.json(contacts);
    } catch (error) {
      sendError(res, error, "Failed to fetch linked contacts");
    }
  });

  app.post('/api/maintenance-requests/:id/contacts/:contactId', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageMaintenance")) return;

      const linkable = await resolveContactLink(res, ctx, req.params.id, req.params.contactId);
      if (!linkable) return;

      await storage.linkContactToRequest(req.params.id, req.params.contactId);
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to link contact");
    }
  });

  app.delete('/api/maintenance-requests/:id/contacts/:contactId', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageMaintenance")) return;

      const linkable = await resolveContactLink(res, ctx, req.params.id, req.params.contactId);
      if (!linkable) return;

      await storage.unlinkContactFromRequest(req.params.id, req.params.contactId);
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to unlink contact");
    }
  });

  // ---------------------------------------------------------------------------
  // Request threads
  //
  // Thread access is request access: every route here resolves the request,
  // then decides through canReadComment / canPostComment / canDeleteComment
  // in authz.ts and nothing else, so ownership, the house match, region
  // scoping and the 120-day closed window all reach a thread without a
  // second implementation. Filtering is server-side -- an internal comment
  // never leaves the process for a resident. No audit event: a comment is
  // neither access, money nor a document, and logging every one would bury
  // the events that are.
  // ---------------------------------------------------------------------------

  /**
   * The request a thread hangs off, or a 404. Existence is answered before
   * access here, as on every other maintenance route -- known issue 3: an
   * out-of-region id gets a 403, which confirms it exists. Accepted.
   */
  async function requestForThread(req: any, res: Response) {
    const request = await storage.getMaintenanceRequest(req.params.id);
    if (!request) {
      res.status(404).json({ message: "Maintenance request not found" });
      return null;
    }
    return request;
  }

  /**
   * The file a body names, checked to be one this caller stored.
   *
   * A file inherits the visibility of every record that points at it, and one
   * readable reference is enough to serve it -- so a body naming somebody
   * else's upload (a vendor's W-9, say) would hand that file to everyone who
   * can read the comment or the bid. The schema checked the URL's shape;
   * here the row has to exist and be theirs, the same check
   * attachRequestPhotos makes. No URL means no file, whatever name the body
   * gave; no name means the name the file was stored under.
   */
  async function ownUploadFromClient(
    ctx: AuthContext,
    url: string | null | undefined,
    name: string | null | undefined,
  ): Promise<{ url: string; name: string } | null> {
    if (!url) return null;
    const key = url.slice("/uploads/".length);
    const upload = isSafeStorageKey(key) ? await storage.getUploadByStorageKey(key) : undefined;
    if (!upload || upload.uploadedBy !== ctx.userId) {
      throw new HttpError(400, "That file is not one you uploaded. Upload it again and try saving.");
    }
    return { url, name: name || upload.originalName };
  }

  /**
   * The same rule for a record's plain file columns -- a request or house
   * photo, a walkthrough or asset photo, a billing record's three documents.
   * Every new value must be an upload the caller stored. A value the stored
   * row already holds is not a new reference and passes, so an edit that
   * resends a colleague's photo is not refused; null clears. Runs before any
   * write, so a refusal leaves nothing behind.
   */
  async function requireOwnUploads(
    ctx: AuthContext,
    incoming: Record<string, unknown>,
    fields: readonly string[],
    existing?: Record<string, unknown>,
  ): Promise<void> {
    for (const field of fields) {
      const url = incoming[field];
      if (url === undefined || url === null || url === "") continue;
      if (existing && url === existing[field]) continue;
      if (typeof url !== "string" || !UPLOAD_URL_PATTERN.test(url)) {
        throw new HttpError(400, "That is not an uploaded file. Upload it again and try saving.");
      }
      await ownUploadFromClient(ctx, url, null);
    }
  }

  /**
   * The stored files an edit drops: each named field the edit changes (or
   * clears) whose current value is an upload. Handed to
   * `removeDeletedRecordFiles` after the save, which keeps any file another
   * record still points at. A field the edit leaves out, or resends
   * unchanged, drops nothing.
   */
  function replacedFileUrls(
    existing: Record<string, unknown>,
    incoming: Record<string, unknown>,
    fields: readonly string[],
  ): string[] {
    return fields.flatMap((field) => {
      const before = existing[field];
      const after = incoming[field];
      if (after === undefined || typeof before !== "string" || before === "") return [];
      return after === before ? [] : [before];
    });
  }

  app.get('/api/maintenance-requests/:id/comments', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      const request = await requestForThread(req, res);
      if (!request) return;
      const residentHouse = await residentHouseAddress(ctx);
      if (!requireMaintenanceRequestAccess(res, ctx, request, residentHouse)) return;

      const comments = await storage.getMaintenanceRequestComments(request.id);
      res.json(comments.filter((comment) => canReadComment(ctx, request, comment, residentHouse)));
    } catch (error) {
      sendError(res, error, "Failed to fetch the thread");
    }
  });

  app.post('/api/maintenance-requests/:id/comments', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      const request = await requestForThread(req, res);
      if (!request) return;

      const parsed = insertMaintenanceRequestCommentSchema.parse(req.body);
      // A household's comment is shared whatever the body says. Their
      // composer has no visibility control, so a body marked internal from
      // that tier is a client mistake, not a grant -- forced here rather
      // than refused, the way the resident create route forces the type.
      // canPostComment then decides the rest: own house,
      // a repair, inside the 120-day window unless they filed it.
      const isInternal = ctx.isResident ? false : (parsed.isInternal ?? true);
      const residentHouse = await residentHouseAddress(ctx);
      if (!canPostComment(ctx, request, { isInternal }, residentHouse)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      // After the post rule, so a refused caller learns nothing about which
      // storage keys exist.
      const attachment = await ownUploadFromClient(ctx, parsed.attachmentUrl, parsed.attachmentName);
      // A relayed contractor is linked like any contact: it must exist and be
      // in a region the caller can reach. Residents never relay.
      const relayContactId = ctx.isResident ? null : parsed.relayContactId || null;
      if (relayContactId) {
        const contact = await storage.getMaintenanceContact(relayContactId);
        if (!contact) {
          return res.status(400).json({ message: "That contractor is not on file. Pick one from the list or leave it blank." });
        }
        if (!requireRegion(res, ctx, contact.region)) return;
      }

      // The author is the session, never the body. The name is stored beside
      // the id so the thread still says who wrote it after the account goes.
      const authorName = [ctx.user.firstName, ctx.user.lastName].filter(Boolean).join(" ") || null;
      const comment = await storage.createMaintenanceRequestComment({
        body: commentBodyFromClient(parsed.body),
        isInternal,
        attachmentUrl: attachment?.url ?? null,
        attachmentName: attachment?.name ?? null,
        // Relaying is a staff act -- an RA passing on a contractor's words.
        // A resident's comment is their own, whatever the body claims.
        relaySource: ctx.isResident ? null : parsed.relaySource || null,
        relayContactId,
        requestId: request.id,
        authorUserId: ctx.userId,
        authorEmail: ctx.user.email ?? null,
        authorName,
      });
      // Saved first, emailed second: a mail outage never loses what was typed.
      await emailThreadAbout(request, comment);
      res.status(201).json(comment);
    } catch (error) {
      sendError(res, error, "Failed to post the comment");
    }
  });

  app.delete('/api/maintenance-request-comments/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      const comment = await storage.getMaintenanceRequestComment(req.params.id);
      if (!comment) {
        return res.status(404).json({ message: "Comment not found" });
      }
      // Reading the request first: somebody who may not see the thread may
      // not take a comment off it, whatever the author column says.
      const request = await storage.getMaintenanceRequest(comment.requestId);
      if (!request) {
        return res.status(404).json({ message: "Maintenance request not found" });
      }
      const residentHouse = await residentHouseAddress(ctx);
      if (!canReadComment(ctx, request, comment, residentHouse) || !canDeleteComment(ctx, comment)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      await removeDeletedRecordFiles(await storage.deleteMaintenanceRequestComment(comment.id));
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete the comment");
    }
  });

  // ---------------------------------------------------------------------------
  // Bids on a project
  //
  // The cost of ADR-0001 made concrete: bids and contract terms sit in the
  // table a household leader can already read, so everything here is staff
  // under the maintenance permission, region-checked through the request, and
  // refused outright on a repair. A resident never reaches a bid because they
  // never reach its parent, and the upload-reference rule in authz.ts refuses
  // them by name besides. Delete is a hard delete and takes the quote with it
  // (removeDeletedRecordFiles), unless another record still points at the file.
  // ---------------------------------------------------------------------------

  /**
   * The project a bid route is about, or null after a response has been sent.
   * Existence, then region, then type -- region before type, so an
   * out-of-region caller learns nothing about what kind of work it is.
   */
  async function bidParent(res: Response, ctx: AuthContext, requestId: string): Promise<MaintenanceRequest | null> {
    const request = await storage.getMaintenanceRequest(requestId);
    if (!request) {
      res.status(404).json({ message: "Maintenance request not found" });
      return null;
    }
    if (!requireRegion(res, ctx, request.region)) return null;
    if (!isProjectType(request.type)) {
      res.status(400).json({ message: "Only projects and capital projects carry bids" });
      return null;
    }
    return request;
  }

  /** The bid in the URL and the project it is on, with the same checks. */
  async function bidAndParent(res: Response, ctx: AuthContext, bidId: string) {
    const bid = await storage.getMaintenanceRequestBid(bidId);
    if (!bid) {
      res.status(404).json({ message: "Bid not found" });
      return null;
    }
    const request = await bidParent(res, ctx, bid.requestId);
    return request ? { bid, request } : null;
  }

  /**
   * The contact a bid names, checked to exist and to be in the caller's
   * reach -- the same rule as linking a contractor to a request, so a bid
   * cannot become a way to attach a vendor the caller could not open.
   */
  async function requireBidContact(res: Response, ctx: AuthContext, contactId: string | null | undefined): Promise<boolean> {
    if (!contactId) return true;
    const contact = await storage.getMaintenanceContact(contactId);
    if (!contact) {
      res.status(400).json({ message: "That contractor is not on file. Pick one from the list or type the company's name." });
      return false;
    }
    return requireRegion(res, ctx, contact.region);
  }

  const NO_VENDOR = "A bid needs a contractor: pick one from the list or type the company's name.";

  app.get('/api/maintenance-requests/:id/bids', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewMaintenance", "canManageMaintenance")) return;
      const request = await bidParent(res, ctx, req.params.id);
      if (!request) return;

      res.json(await storage.getMaintenanceRequestBids(request.id));
    } catch (error) {
      sendError(res, error, "Failed to fetch bids");
    }
  });

  app.post('/api/maintenance-requests/:id/bids', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageMaintenance")) return;
      const request = await bidParent(res, ctx, req.params.id);
      if (!request) return;

      const parsed = insertMaintenanceRequestBidSchema.parse(req.body);
      if (!bidNamesAVendor(parsed)) return res.status(400).json({ message: NO_VENDOR });
      if (!(await requireBidContact(res, ctx, parsed.contactId))) return;
      const file = await ownUploadFromClient(ctx, parsed.documentUrl, parsed.documentName);

      const bid = await storage.createMaintenanceRequestBid({
        ...parsed,
        documentUrl: file?.url ?? null,
        documentName: file?.name ?? null,
        requestId: request.id,
      });
      res.status(201).json(bid);
    } catch (error) {
      sendError(res, error, "Failed to record the bid");
    }
  });

  app.patch('/api/maintenance-request-bids/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageMaintenance")) return;
      const found = await bidAndParent(res, ctx, req.params.id);
      if (!found) return;

      const parsed = insertMaintenanceRequestBidSchema.partial().parse(req.body);
      // The schema strips what an edit may not touch (accepted, the request,
      // the id); a body of only those leaves nothing for the database to set.
      if (Object.keys(parsed).length === 0) {
        return res.status(400).json({ message: "There is nothing to change on this bid" });
      }
      // The vendor rule holds over the row as it will be, not the patch alone:
      // an edit that clears the name on a bid with no contact leaves nobody.
      if (!bidNamesAVendor({ ...found.bid, ...parsed })) return res.status(400).json({ message: NO_VENDOR });
      if (parsed.contactId !== undefined && !(await requireBidContact(res, ctx, parsed.contactId))) return;

      // A document left out of the body is left alone; null clears it; a URL
      // has to be a file this caller stored.
      let document = {};
      if (parsed.documentUrl !== undefined) {
        const file = await ownUploadFromClient(ctx, parsed.documentUrl, parsed.documentName);
        document = { documentUrl: file?.url ?? null, documentName: file?.name ?? null };
      }

      res.json(await storage.updateMaintenanceRequestBid(found.bid.id, { ...parsed, ...document }));
    } catch (error) {
      sendError(res, error, "Failed to update the bid");
    }
  });

  app.delete('/api/maintenance-request-bids/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageMaintenance")) return;
      const found = await bidAndParent(res, ctx, req.params.id);
      if (!found) return;

      await removeDeletedRecordFiles(await storage.deleteMaintenanceRequestBid(found.bid.id));
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to remove the bid");
    }
  });

  // Accepting is its own route and one storage call: the bid becomes the
  // accepted one and every other bid on the request stops being, in the same
  // transaction. That is how "at most one accepted bid" is enforced rather
  // than left to a client remembering to clear the others.
  app.post('/api/maintenance-request-bids/:id/accept', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageMaintenance")) return;
      const found = await bidAndParent(res, ctx, req.params.id);
      if (!found) return;

      const bid = await storage.acceptMaintenanceRequestBid(found.request.id, found.bid.id);
      // No row back means the bid went between the lookup above and the
      // write: say so rather than answer with an acceptance that never happened.
      if (!bid) {
        return res.status(404).json({ message: "Bid not found" });
      }
      res.json(bid);
    } catch (error) {
      sendError(res, error, "Failed to accept the bid");
    }
  });

  // Walkthrough Rooms Routes
  // ---------------------------------------------------------------------------
  // The national walkthrough template
  //
  // One template for the whole organisation: the standard rooms, and the
  // standard items in each. Reading it needs the ordinary walkthrough
  // permission -- an RA picking a room type has to see the list.
  //
  // CHANGING it is admin-only, and deliberately not `canManageWalkthroughs`.
  // That flag is region-scoped in intent: a regional administrator manages
  // their own houses. This template is national, so an edit here reaches every
  // region, which is a different thing from managing walkthroughs and needs a
  // different grant. requireAdmin is that grant.
  //
  // Editing the template never changes a property's existing walkthrough,
  // because a walkthrough owns copies of these rows rather than references.
  // ---------------------------------------------------------------------------

  app.get('/api/walkthrough-template/rooms', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      // Reachable by a household leader too: this is the room-type list the
      // add-a-room picker reads, and without it they can add nothing. It
      // carries no house, so it discloses nothing about anybody's property.
      if (!requireWalkthroughPermission(res, ctx, "view")) return;

      // National, so no region filter: the room types are the same everywhere.
      res.json(await storage.getAllWalkthroughTemplateRooms());
    } catch (error) {
      sendError(res, error, "Failed to fetch the walkthrough template");
    }
  });

  app.get('/api/walkthrough-template/items', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewWalkthroughs", "canManageWalkthroughs")) return;

      res.json(await storage.getAllWalkthroughTemplateItems());
    } catch (error) {
      sendError(res, error, "Failed to fetch the walkthrough template");
    }
  });

  app.post('/api/walkthrough-template/rooms', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      res.json(await storage.createWalkthroughTemplateRoom(insertWalkthroughTemplateRoomSchema.parse(req.body)));
    } catch (error) {
      sendError(res, error, "Failed to add the room type");
    }
  });

  app.patch('/api/walkthrough-template/rooms/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      if (!(await storage.getWalkthroughTemplateRoom(req.params.id))) {
        return res.status(404).json({ message: "Room type not found" });
      }
      const data = insertWalkthroughTemplateRoomSchema.partial().parse(req.body ?? {});
      res.json(await storage.updateWalkthroughTemplateRoom(req.params.id, data));
    } catch (error) {
      sendError(res, error, "Failed to update the room type");
    }
  });

  app.delete('/api/walkthrough-template/rooms/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      if (!(await storage.getWalkthroughTemplateRoom(req.params.id))) {
        return res.status(404).json({ message: "Room type not found" });
      }
      // Its template items cascade. Walkthroughs already created keep their
      // own copies, which is the point of copying rather than referencing.
      await storage.deleteWalkthroughTemplateRoom(req.params.id);
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete the room type");
    }
  });

  app.post('/api/walkthrough-template/items', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const data = insertWalkthroughTemplateItemSchema.parse(req.body);
      if (!(await storage.getWalkthroughTemplateRoom(data.templateRoomId))) {
        return res.status(404).json({ message: "Room type not found" });
      }
      res.json(await storage.createWalkthroughTemplateItem(data));
    } catch (error) {
      sendError(res, error, "Failed to add the item");
    }
  });

  app.patch('/api/walkthrough-template/items/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      if (!(await storage.getWalkthroughTemplateItem(req.params.id))) {
        return res.status(404).json({ message: "Item not found" });
      }
      // An item cannot be moved between room types; delete and re-add instead.
      const { templateRoomId: _t, ...editable } = req.body ?? {};
      const data = insertWalkthroughTemplateItemSchema.partial().parse(editable);
      res.json(await storage.updateWalkthroughTemplateItem(req.params.id, data));
    } catch (error) {
      sendError(res, error, "Failed to update the item");
    }
  });

  app.delete('/api/walkthrough-template/items/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      if (!(await storage.getWalkthroughTemplateItem(req.params.id))) {
        return res.status(404).json({ message: "Item not found" });
      }
      await storage.deleteWalkthroughTemplateItem(req.params.id);
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete the item");
    }
  });

  // ---------------------------------------------------------------------------
  // Walkthroughs
  //
  // A dated inspection event for one house. Rooms hang off one of these rather
  // than off the property directly, which is what makes a year-over-year
  // comparison possible at all.
  //
  // Two tiers reach these routes by two different rules. Staff are scoped by
  // the region denormalised onto the walkthrough itself, exactly as on
  // residents and schedules. A household leader or steward holding
  // canCompleteWalkthroughs is scoped to the single house their login is
  // linked to, and has no region path at any point. requireWalkthroughPermission
  // and requireWalkthroughAccess in server/authz.ts hold both halves of that,
  // so no handler here decides it for itself.
  // ---------------------------------------------------------------------------

  app.get('/api/walkthroughs', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireWalkthroughPermission(res, ctx, "view")) return;

      // Staff are filtered by region, a household leader by their own house.
      // visibleWalkthroughs keeps the two apart -- a resident never falls
      // through to the region rule, however their permissions row is set.
      res.json(
        visibleWalkthroughs(
          ctx,
          await storage.getAllWalkthroughs(),
          await residentHouseAddress(ctx),
        ),
      );
    } catch (error) {
      sendError(res, error, "Failed to fetch walkthroughs");
    }
  });

  app.get('/api/walkthroughs/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireWalkthroughPermission(res, ctx, "view")) return;

      const walkthrough = await storage.getWalkthrough(req.params.id);
      if (!walkthrough) {
        return res.status(404).json({ message: "Walkthrough not found" });
      }
      if (!(await requireWalkthroughAccess(res, ctx, walkthrough))) return;

      res.json(walkthrough);
    } catch (error) {
      sendError(res, error, "Failed to fetch walkthrough");
    }
  });

  app.get('/api/walkthroughs/:id/rooms', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireWalkthroughPermission(res, ctx, "view")) return;

      // Authorize against the parent before reading its children, so a guessed
      // walkthrough id belonging to another house cannot enumerate its rooms.
      const walkthrough = await storage.getWalkthrough(req.params.id);
      if (!walkthrough) {
        return res.status(404).json({ message: "Walkthrough not found" });
      }
      if (!(await requireWalkthroughAccess(res, ctx, walkthrough))) return;

      res.json(await storage.getWalkthroughRoomsByWalkthrough(req.params.id));
    } catch (error) {
      sendError(res, error, "Failed to fetch walkthrough rooms");
    }
  });

  /**
   * Every item in a walkthrough, across all of its rooms.
   *
   * The mobile screen shows one room at a time but needs the whole checklist
   * up front: progress across the house, and which rooms are still untouched,
   * are the two things that let an RA skip around instead of working through
   * the list in order.
   *
   * Authorized against the parent walkthrough for the same reason the rooms
   * route is: a guessed id in another region must not enumerate that house's
   * checklist.
   */
  app.get('/api/walkthroughs/:id/items', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireWalkthroughPermission(res, ctx, "view")) return;

      const walkthrough = await storage.getWalkthrough(req.params.id);
      if (!walkthrough) {
        return res.status(404).json({ message: "Walkthrough not found" });
      }
      if (!(await requireWalkthroughAccess(res, ctx, walkthrough))) return;

      res.json(await storage.getWalkthroughItemsByWalkthrough(req.params.id));
    } catch (error) {
      sendError(res, error, "Failed to fetch walkthrough items");
    }
  });

  app.post('/api/walkthroughs', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireWalkthroughPermission(res, ctx, "manage")) return;

      const property = await storage.getProperty(req.body?.propertyId);
      if (!property) {
        return res.status(404).json({ message: "Property not found" });
      }
      // The house being started is checked the same way a walkthrough is: by
      // region for staff, by the caller's own address for a household leader.
      if (
        !(await requireWalkthroughAccess(
          res,
          ctx,
          { region: property.region, buildingAddress: property.address },
          "Forbidden - Cannot create for this property",
        ))
      ) {
        return;
      }

      // region and buildingAddress come from the property, never the caller,
      // so a walkthrough cannot be filed into a region its author cannot see.
      // Nor does the status: every walkthrough starts as a draft, and only the
      // submit and review routes move it on.
      const { status: _status, ...startBody } = req.body ?? {};
      const validatedData = insertWalkthroughSchema.parse({
        ...startBody,
        region: property.region,
        buildingAddress: property.address,
        performedBy: ctx.user.email ?? null,
      });

      const walkthrough = await storage.createWalkthrough(validatedData);

      // Seeding happens after the walkthrough exists, so a failure here leaves
      // a real but empty walkthrough rather than nothing. Returning a 500 at
      // that point would tell an RA the whole thing failed when it did not, and
      // they would start a second one. Instead the error is logged and the
      // count comes back, so the UI can say the checklist did not load and
      // offer to add rooms by hand.
      let roomsCreated = 0;
      try {
        roomsCreated = await seedWalkthroughStructure(walkthrough);
      } catch (error) {
        logError("Failed to seed a new walkthrough from the template", error);
      }

      res.json({ ...walkthrough, roomsCreated });
    } catch (error) {
      sendError(res, error, "Failed to create walkthrough");
    }
  });

  /**
   * Fills a brand-new walkthrough with the rooms and items it should start
   * with: the national template on a property's first, and that property's
   * most recent walkthrough on every one after.
   *
   * Structure only. Conditions start unassessed and photos are never copied --
   * a new walkthrough is a fresh inspection, not a duplicate of the last one.
   */
  async function seedWalkthroughStructure(walkthrough: {
    id: string;
    propertyId: string;
    buildingAddress?: string;
  }): Promise<number> {
    const previous = ((await storage.getWalkthroughsByProperty(walkthrough.propertyId)) ?? [])
      .filter((w) => w.id !== walkthrough.id);

    let planned;
    if (previous.length === 0) {
      const [templateRooms, templateItems] = await Promise.all([
        storage.getAllWalkthroughTemplateRooms(),
        storage.getAllWalkthroughTemplateItems(),
      ]);
      planned = planFromTemplate(templateRooms ?? [], templateItems ?? []);
    } else {
      // getWalkthroughsByProperty is newest first.
      const rooms = (await storage.getWalkthroughRoomsByWalkthrough(previous[0].id)) ?? [];
      const items = (
        await Promise.all(rooms.map(async (room) => (await storage.getWalkthroughItemsByRoom(room.id)) ?? []))
      ).flat();
      planned = planFromPreviousWalkthrough(rooms, items);
    }

    for (const room of planned) {
      const created = await storage.createWalkthroughRoom({
        name: room.name,
        walkthroughId: walkthrough.id,
        propertyId: walkthrough.propertyId,
        buildingAddress: walkthrough.buildingAddress ?? "",
        displayOrder: room.displayOrder,
        standingNote: room.standingNote,
      });
      for (const item of room.items) {
        await storage.createWalkthroughItem({
          roomId: created.id,
          label: item.label,
          displayOrder: item.displayOrder,
          standingNote: item.standingNote,
        });
      }
    }
    return planned.length;
  }

  /**
   * Adds one room to an existing walkthrough, prefilled from a known room type.
   *
   * The prefill is the point: add a bathroom and get sink, toilet, tub and
   * shower, then delete what is not there. Typing four items by hand is what
   * stops people editing the checklist at all.
   */
  app.post('/api/walkthroughs/:id/rooms', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireWalkthroughPermission(res, ctx, "manage")) return;

      const walkthrough = await storage.getWalkthrough(req.params.id);
      if (!walkthrough) {
        return res.status(404).json({ message: "Walkthrough not found" });
      }
      if (!(await requireWalkthroughAccess(res, ctx, walkthrough))) return;
      // A household leader adds rooms to the inspection they are performing,
      // never to a prior year's. No-op for staff, who correct any year.
      if (!(await requireCurrentWalkthrough(res, ctx, walkthrough))) return;

      const body = z
        .object({
          templateRoomId: z.string().optional(),
          name: z.string().min(1).optional(),
          displayOrder: z.number().int().min(0).optional(),
        })
        .parse(req.body ?? {});

      let name = body.name;
      let items: { label: string; displayOrder: number }[] = [];

      if (body.templateRoomId) {
        const templateRoom = await storage.getWalkthroughTemplateRoom(body.templateRoomId);
        if (!templateRoom) {
          return res.status(404).json({ message: "Room type not found" });
        }
        name = name ?? templateRoom.name;
        items = templateRoomItems(body.templateRoomId, await storage.getAllWalkthroughTemplateItems());
      }

      if (!name) {
        return res.status(400).json({ message: "Give the room a name, or choose a room type" });
      }

      const existing = await storage.getWalkthroughRoomsByWalkthrough(walkthrough.id);
      const room = await storage.createWalkthroughRoom({
        name,
        walkthroughId: walkthrough.id,
        propertyId: walkthrough.propertyId,
        buildingAddress: walkthrough.buildingAddress,
        displayOrder: body.displayOrder ?? existing.length,
      });

      for (const item of items) {
        await storage.createWalkthroughItem({
          roomId: room.id,
          label: item.label,
          displayOrder: item.displayOrder,
        });
      }

      res.json({ ...room, itemsCreated: items.length });
    } catch (error) {
      sendError(res, error, "Failed to add the room");
    }
  });

  app.patch('/api/walkthroughs/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageWalkthroughs")) return;

      const existing = await storage.getWalkthrough(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Walkthrough not found" });
      }
      if (!requireRegion(res, ctx, existing.region)) return;

      // The house a walkthrough belongs to is fixed, so its property and the
      // region and address derived from it are not editable. The status is
      // not either: the submit and review routes below are its only writers.
      const { propertyId: _p, region: _r, buildingAddress: _b, status: _s, ...editable } = req.body ?? {};
      const validatedData = insertWalkthroughSchema.partial().parse(editable);

      res.json(await storage.updateWalkthrough(req.params.id, validatedData));
    } catch (error) {
      sendError(res, error, "Failed to update walkthrough");
    }
  });

  // The two writers of `status` (2026-09 RA review, 7.1). Submitting is what
  // whoever filled the walkthrough in does when the house is walked -- a
  // leader on their own current one, or staff -- and it moves draft to
  // submitted. Reviewing is staff reading it over: submitted to reviewed.
  // Neither locks anything; the date rule stays the only lock, so a leader
  // can still fix a note after submitting and their RA can correct any year.
  // The damages worksheet opens on a move-out that has reached either. No
  // audit event: not access, money or a document.
  app.post('/api/walkthroughs/:id/submit', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireWalkthroughPermission(res, ctx, "manage")) return;

      const existing = await storage.getWalkthrough(req.params.id);
      if (!existing) return res.status(404).json({ message: "Walkthrough not found" });
      if (!(await requireWalkthroughAccess(res, ctx, existing))) return;
      if (!(await requireCurrentWalkthrough(res, ctx, existing))) return;
      if (existing.status !== "draft") {
        return res.status(409).json({ message: "This walkthrough has already been submitted" });
      }

      res.json(await storage.updateWalkthrough(existing.id, { status: "submitted" }));
    } catch (error) {
      sendError(res, error, "Failed to submit this walkthrough");
    }
  });

  app.post('/api/walkthroughs/:id/review', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageWalkthroughs")) return;

      const existing = await storage.getWalkthrough(req.params.id);
      if (!existing) return res.status(404).json({ message: "Walkthrough not found" });
      if (!requireRegion(res, ctx, existing.region)) return;
      if (existing.status !== "submitted") {
        return res.status(409).json({
          message: existing.status === "draft" ? "Mark it submitted first" : "This walkthrough has already been reviewed",
        });
      }

      res.json(await storage.updateWalkthrough(existing.id, { status: "reviewed" }));
    } catch (error) {
      sendError(res, error, "Failed to mark this walkthrough reviewed");
    }
  });

  app.delete('/api/walkthroughs/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageWalkthroughs")) return;

      const existing = await storage.getWalkthrough(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Walkthrough not found" });
      }
      if (!requireRegion(res, ctx, existing.region)) return;

      await removeDeletedRecordFiles(await storage.deleteWalkthrough(req.params.id));
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete walkthrough");
    }
  });

  // ---------------------------------------------------------------------------
  // Walkthrough items
  //
  // An item has no region of its own. It inherits the room's, which inherits
  // the walkthrough's -- so every one of these resolves the chain and checks
  // the region at the top of it before touching anything.
  // ---------------------------------------------------------------------------

  /**
   * The walkthrough an item belongs to, or undefined when the chain is broken.
   *
   * Returns undefined rather than throwing so callers fail closed: a room with
   * no walkthrough, or a walkthrough that has been deleted, grants nothing.
   * The whole record comes back rather than just its region, because the house
   * on it is what a household leader is checked against.
   */
  async function walkthroughForRoom(roomId: string) {
    const room = await storage.getWalkthroughRoom(roomId);
    if (!room?.walkthroughId) return undefined;
    return await storage.getWalkthrough(room.walkthroughId);
  }

  /**
   * Every item across every walkthrough the caller can see whose condition is
   * poor or damaged.
   *
   * The pain point this answers is a deep hole in a wall going unnoticed
   * because finding it means opening walkthroughs one at a time. So this is a
   * read over the whole visible set rather than one house's.
   *
   * Scoped by `visibleWalkthroughs`, not `filterByRegion`, for the same reason
   * the walkthrough list is: a household leader has no regions and must never
   * acquire any here. Theirs narrows to their own house, and an account with
   * no house claim gets an empty list rather than falling through to the
   * region rule.
   */
  app.get('/api/walkthrough-flagged-items', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireWalkthroughPermission(res, ctx, "view")) return;

      res.json(
        visibleWalkthroughs(
          ctx,
          await storage.getFlaggedWalkthroughItems(),
          await residentHouseAddress(ctx),
        ),
      );
    } catch (error) {
      sendError(res, error, "Failed to fetch flagged walkthrough items");
    }
  });

  app.get('/api/walkthrough-rooms/:roomId/items', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireWalkthroughPermission(res, ctx, "view")) return;

      const walkthrough = await walkthroughForRoom(req.params.roomId);
      if (!(await requireWalkthroughAccess(res, ctx, walkthrough))) return;

      res.json(await storage.getWalkthroughItemsByRoom(req.params.roomId));
    } catch (error) {
      sendError(res, error, "Failed to fetch walkthrough items");
    }
  });

  app.post('/api/walkthrough-items', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageWalkthroughs")) return;

      const validatedData = insertWalkthroughItemSchema.parse(req.body);
      // Staff-only on purpose, so still the plain region check rather than the
      // two-tier guard above: adding a checklist line back is not one of the
      // edits the walkthrough screen offers a household leader, and the
      // template is where the standard items are decided.
      const walkthrough = await walkthroughForRoom(validatedData.roomId);
      if (!requireRegion(res, ctx, walkthrough?.region, "Forbidden - Cannot create in this region")) return;

      res.json(await storage.createWalkthroughItem(validatedData));
    } catch (error) {
      sendError(res, error, "Failed to create walkthrough item");
    }
  });

  const RESIDENT_ITEM_FIELDS = ["condition", "notes"];

  app.patch('/api/walkthrough-items/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireWalkthroughPermission(res, ctx, "manage")) return;

      const existing = await storage.getWalkthroughItem(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Walkthrough item not found" });
      }
      const walkthrough = await walkthroughForRoom(existing.roomId);
      if (!(await requireWalkthroughAccess(res, ctx, walkthrough))) return;
      // "Read prior years read-only": a leader records conditions on the
      // current inspection of their house only. No-op for staff.
      if (!(await requireCurrentWalkthrough(res, ctx, walkthrough))) return;

      // An item cannot be moved to another room: that would carry it into a
      // different walkthrough, and possibly a different region.
      const { roomId: _r, ...editable } = req.body ?? {};
      // A standing note is staff instruction to the household, so a resident
      // may read it and never write it -- refused, not silently dropped, so a
      // client mistake is visible.
      if (ctx.isResident && "standingNote" in editable) {
        return res.status(403).json({ message: "Forbidden - Standing notes are written by staff" });
      }
      // A leader records condition and notes and nothing else. The label and
      // the order carry forward to next year and into the move-out comparison
      // and the damages worksheet, so changing them is staff work. Refused,
      // not dropped, for the same reason as the standing note.
      if (ctx.isResident && Object.keys(editable).some((key) => !RESIDENT_ITEM_FIELDS.includes(key))) {
        return res.status(403).json({ message: "Forbidden - A household records condition and notes only" });
      }
      const validatedData = insertWalkthroughItemSchema.partial().parse(editable);

      res.json(await storage.updateWalkthroughItem(req.params.id, validatedData));
    } catch (error) {
      sendError(res, error, "Failed to update walkthrough item");
    }
  });

  app.delete('/api/walkthrough-items/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      // Staff only (2026-09 RA review, item 1.3). A leader used to be able to
      // remove an item their house lacks; now they ask their RA, who can
      // still correct anything on any year. Decided before the item is even
      // loaded, so a refused delete touches nothing.
      if (!requireStaff(res, ctx)) return;
      if (!requireWalkthroughPermission(res, ctx, "manage")) return;

      const existing = await storage.getWalkthroughItem(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Walkthrough item not found" });
      }
      const walkthrough = await walkthroughForRoom(existing.roomId);
      if (!(await requireWalkthroughAccess(res, ctx, walkthrough))) return;
      if (!(await requireCurrentWalkthrough(res, ctx, walkthrough))) return;

      await storage.deleteWalkthroughItem(req.params.id);
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete walkthrough item");
    }
  });

  // One checklist item with where it sits, for a screen that holds only the
  // item's id: the request page linking back to the walkthrough it came from.
  // The read rule is the item's walkthrough's, so a leader reaches their own
  // house's and nobody else's.
  app.get('/api/walkthrough-items/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireWalkthroughPermission(res, ctx, "view")) return;

      const item = await storage.getWalkthroughItem(req.params.id);
      if (!item) return res.status(404).json({ message: "Walkthrough item not found" });
      const room = await storage.getWalkthroughRoom(item.roomId);
      const walkthrough = room?.walkthroughId ? await storage.getWalkthrough(room.walkthroughId) : undefined;
      // A legacy room with no walkthrough is a 404 for everyone, admins
      // included -- the access rule would let an admin through to nothing.
      if (!room || !walkthrough) return res.status(404).json({ message: "Walkthrough item not found" });
      if (!(await requireWalkthroughAccess(res, ctx, walkthrough))) return;

      res.json({ ...item, roomName: room.name, walkthroughId: walkthrough.id, walkthroughDate: walkthrough.walkthroughDate });
    } catch (error) {
      sendError(res, error, "Failed to fetch walkthrough item");
    }
  });

  /**
   * A flagged item for a staff write: dismissing it, or raising a repair from
   * it. Staff only (a leader has no business deciding a hole is fine), the
   * given permission, and the walkthrough's region. Decided before the item
   * is loaded, so a refusal reads nothing.
   */
  async function walkthroughItemForStaff(
    req: any,
    res: Response,
    ctx: AuthContext,
    permission: "canManageWalkthroughs" | "canManageMaintenance",
  ) {
    if (!requireStaff(res, ctx)) return undefined;
    if (!requirePermission(res, ctx, permission)) return undefined;
    // Both writes are also walkthrough reads, so the walkthrough grant is
    // checked here, before anything is loaded, for staff as for residents.
    if (!requireWalkthroughPermission(res, ctx, "view")) return undefined;
    const item = await storage.getWalkthroughItem(req.params.id);
    if (!item) {
      res.status(404).json({ message: "Walkthrough item not found" });
      return undefined;
    }
    const room = await storage.getWalkthroughRoom(item.roomId);
    const walkthrough = room?.walkthroughId ? await storage.getWalkthrough(room.walkthroughId) : undefined;
    if (!room || !walkthrough) {
      res.status(404).json({ message: "Walkthrough item not found" });
      return undefined;
    }
    if (!(await requireWalkthroughAccess(res, ctx, walkthrough))) return undefined;
    return { item, room, walkthrough };
  }

  // Dismissing a flagged item: somebody marked it poor and it turned out fine.
  // Who, when and a required reason, the asset-snooze shape. It leaves the
  // needs-attention list and stays on the walkthrough saying so; the recorded
  // condition is not rewritten. No audit event: not access, money or documents.
  app.post('/api/walkthrough-items/:id/dismiss', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      const found = await walkthroughItemForStaff(req, res, ctx, "canManageWalkthroughs");
      if (!found) return;

      const body = z
        .object({
          reason: z
            .string()
            .trim()
            .min(1, "Say why this does not need attention — it is what the next RA reads")
            .max(500, "Keep the reason under 500 characters"),
        })
        .parse(req.body);

      res.json(
        await storage.updateWalkthroughItem(found.item.id, {
          dismissedAt: new Date(),
          dismissReason: body.reason,
          dismissedByUserId: ctx.userId,
        }),
      );
    } catch (error) {
      sendError(res, error, "Failed to dismiss this item");
    }
  });

  app.delete('/api/walkthrough-items/:id/dismiss', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      const found = await walkthroughItemForStaff(req, res, ctx, "canManageWalkthroughs");
      if (!found) return;
      // The reason stays, as a snooze's does: it is the record of why
      // somebody once thought this was fine.
      res.json(await storage.updateWalkthroughItem(found.item.id, { dismissedAt: null }));
    } catch (error) {
      sendError(res, error, "Failed to clear this dismissal");
    }
  });

  // Raising a repair from a flagged item. The request is an ordinary type
  // `request` on the item's house, so the household can read it -- which is
  // correct, and why nothing staff-only is copied: the title, the room, the
  // recorded condition and the item's own notes, which the household wrote or
  // could read anyway. The room's photos are REFERENCED, not re-uploaded: a
  // maintenance_request_photos row per existing upload, which is what makes
  // them readable to the household through the request rule. submittedBy is
  // the acting RA's email, because that column holds an email and ownsRecord
  // compares against one.
  app.post('/api/walkthrough-items/:id/maintenance-request', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      const found = await walkthroughItemForStaff(req, res, ctx, "canManageMaintenance");
      if (!found) return;
      const { item, room, walkthrough } = found;

      const existing = await storage.getMaintenanceRequestByWalkthroughItem(item.id);
      if (existing) {
        return res.status(409).json({ message: "A request was already raised from this item", requestId: existing.id });
      }

      const house = await storage.getProperty(walkthrough.propertyId);
      if (!house) return res.status(400).json({ message: NOT_A_HOUSE_MESSAGE });
      if (!requireRegion(res, ctx, house.region, "Forbidden - Cannot create in this region")) return;

      const submittedBy = ctx.user.email || "Unknown";
      const when = new Date(walkthrough.walkthroughDate).toISOString().slice(0, 10);
      const conditionWord = WALKTHROUGH_CONDITION_LABEL[item.condition] ?? item.condition;
      const notes = item.notes?.trim();
      const description = [
        `Recorded "${conditionWord}" for ${item.label} in the ${room.name} on the ${when} walkthrough.`,
        notes ? `Walkthrough notes: ${notes}` : null,
      ]
        .filter(Boolean)
        .join("\n\n");

      const request = await storage.createMaintenanceRequest({
        title: `${item.label} — ${room.name}`,
        description,
        category: "General",
        priority: "medium",
        type: "request",
        status: "pending",
        location: room.name,
        region: house.region,
        buildingAddress: house.address,
        submittedBy,
        walkthroughItemId: item.id,
      });

      const photos = await storage.getWalkthroughPhotosByRoom(room.id);
      for (const photo of photos) {
        await storage.createMaintenanceRequestPhoto({
          requestId: request.id,
          imageUrl: photo.imageUrl,
          uploadedBy: photo.uploadedBy || submittedBy,
        });
      }

      await emailSubmitter(request, maintenanceReceivedEmail);
      res.status(201).json(request);
    } catch (error) {
      sendError(res, error, "Failed to raise a request from this item");
    }
  });

  app.get('/api/walkthrough-rooms', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewWalkthroughs", "canManageWalkthroughs")) return;

      const rooms = await storage.getAllWalkthroughRooms();
      const properties = await storage.getAllProperties();

      // A room has no region of its own; it inherits the region of the
      // property it belongs to.
      const filteredRooms = filterByRelatedRegion(
        ctx,
        rooms,
        (room) => properties.find((p) => p.id === room.propertyId)?.region,
      );
      res.json(filteredRooms);
    } catch (error) {
      sendError(res, error, "Failed to fetch walkthrough rooms");
    }
  });

  app.post('/api/walkthrough-rooms', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageWalkthroughs")) return;

      const validatedData = insertWalkthroughRoomSchema.parse(req.body);

      // A room belongs to a walkthrough, and the walkthrough carries the
      // region. The house and property come from it, never from the body.
      if (!validatedData.walkthroughId) {
        return res.status(400).json({ message: "A room belongs to a walkthrough. Choose the walkthrough to add it to." });
      }
      const scope = await walkthroughScope(validatedData.walkthroughId);
      if (!scope) {
        return res.status(404).json({ message: "Walkthrough not found" });
      }
      if (!requireRegion(res, ctx, scope.region, "Forbidden - Cannot create in this region")) return;

      const room = await storage.createWalkthroughRoom({
        ...validatedData,
        propertyId: scope.propertyId,
        buildingAddress: scope.buildingAddress,
      });
      res.json(room);
    } catch (error) {
      sendError(res, error, "Failed to create walkthrough room");
    }
  });

  app.patch('/api/walkthrough-rooms/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageWalkthroughs")) return;

      const existingRoom = await storage.getWalkthroughRoom(req.params.id);
      if (!existingRoom) {
        return res.status(404).json({ message: "Walkthrough room not found" });
      }

      const scope = await walkthroughScope(existingRoom.walkthroughId, existingRoom.propertyId);
      if (!requireRegion(res, ctx, scope?.region)) return;

      // A room stays in the walkthrough it was made for: the fields that say
      // where it is are not editable here, so an edit cannot move it into
      // somebody else's region.
      const validatedData = insertWalkthroughRoomSchema
        .omit({ walkthroughId: true, propertyId: true, buildingAddress: true })
        .partial()
        .parse(req.body);

      const room = await storage.updateWalkthroughRoom(req.params.id, validatedData);
      res.json(room);
    } catch (error) {
      sendError(res, error, "Failed to update walkthrough room");
    }
  });

  app.delete('/api/walkthrough-rooms/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageWalkthroughs")) return;

      const existingRoom = await storage.getWalkthroughRoom(req.params.id);
      if (!existingRoom) {
        return res.status(404).json({ message: "Walkthrough room not found" });
      }

      if (!requireRegion(res, ctx, (await walkthroughScope(existingRoom.walkthroughId, existingRoom.propertyId))?.region)) return;

      await removeDeletedRecordFiles(await storage.deleteWalkthroughRoom(req.params.id));
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete walkthrough room");
    }
  });

  // Walkthrough Photos Routes
  app.get('/api/walkthrough-photos', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewWalkthroughs", "canManageWalkthroughs")) return;

      const photos = await storage.getAllWalkthroughPhotos();
      res.json(filterByRegion(ctx, photos));
    } catch (error) {
      sendError(res, error, "Failed to fetch walkthrough photos");
    }
  });

  app.get('/api/walkthrough-photos/room/:roomId', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewWalkthroughs", "canManageWalkthroughs")) return;

      const photos = await storage.getWalkthroughPhotosByRoom(req.params.roomId);
      res.json(filterByRegion(ctx, photos));
    } catch (error) {
      sendError(res, error, "Failed to fetch room photos");
    }
  });

  app.post('/api/walkthrough-photos', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageWalkthroughs")) return;

      const validatedData = insertWalkthroughPhotoSchema.parse(req.body);

      // The room's walkthrough decides the region and the house; the body's
      // copies are overwritten, because the photo's own region is what every
      // later read of it trusts.
      const scope = await roomScope(validatedData.roomId);
      if (!scope) {
        return res.status(404).json({ message: "Walkthrough room not found" });
      }
      if (!requireRegion(res, ctx, scope.region, "Forbidden - Cannot create in this region")) return;
      await requireOwnUploads(ctx, validatedData, ["imageUrl"]);

      // Attribution comes from the session, never the body, so a caller cannot
      // credit a photo to someone else (matches submittedBy on requests).
      const photo = await storage.createWalkthroughPhoto({
        ...validatedData,
        region: scope.region,
        buildingAddress: scope.buildingAddress,
        uploadedBy: ctx.user.email || "Unknown",
      });
      res.json(photo);
    } catch (error) {
      sendError(res, error, "Failed to create walkthrough photo");
    }
  });

  app.patch('/api/walkthrough-photos/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageWalkthroughs")) return;

      const existingPhoto = await storage.getWalkthroughPhoto(req.params.id);
      if (!existingPhoto) {
        return res.status(404).json({ message: "Walkthrough photo not found" });
      }

      if (!requireRegion(res, ctx, (await roomScope(existingPhoto.roomId))?.region)) return;

      // A photo stays in its room, and its region and house follow the room.
      const validatedData = insertWalkthroughPhotoSchema
        .omit({ roomId: true, region: true, buildingAddress: true })
        .partial()
        .parse(req.body);
      await requireOwnUploads(ctx, validatedData, ["imageUrl"], existingPhoto);

      const photo = await storage.updateWalkthroughPhoto(req.params.id, validatedData);
      res.json(photo);
    } catch (error) {
      sendError(res, error, "Failed to update walkthrough photo");
    }
  });

  app.delete('/api/walkthrough-photos/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageWalkthroughs")) return;

      const existingPhoto = await storage.getWalkthroughPhoto(req.params.id);
      if (!existingPhoto) {
        return res.status(404).json({ message: "Walkthrough photo not found" });
      }

      if (!requireRegion(res, ctx, existingPhoto.region)) return;

      await removeDeletedRecordFiles(await storage.deleteWalkthroughPhoto(req.params.id));
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete walkthrough photo");
    }
  });

  // Assets Routes
  app.get('/api/assets', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewAssets", "canManageAssets")) return;

      const visible = filterByRegion(ctx, await storage.getAllAssets());
      // The holder's name, for "who has what" -- the list of accounts is
      // admin-only, and that page exists for a staff departure, where the
      // name is the point. The name alone: nothing else about the account,
      // and only for assets the caller can already see.
      const lentToStaff = visible.some((asset) => asset.assignedUserId);
      const names = new Map<string, string | null>();
      if (lentToStaff) {
        for (const person of await storage.getAllUsers()) {
          names.set(person.id, [person.firstName, person.lastName].filter(Boolean).join(" ").trim() || null);
        }
      }
      const rows: AssetListRow[] = visible.map((asset) => ({
        ...asset,
        assignedUserName: asset.assignedUserId ? names.get(asset.assignedUserId) ?? null : null,
      }));
      res.json(rows);
    } catch (error) {
      sendError(res, error, "Failed to fetch assets");
    }
  });

  app.post('/api/assets', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageAssets")) return;

      const validatedData = insertAssetSchema.parse(req.body);

      if (!requireRegion(res, ctx, validatedData.region, "Forbidden - Cannot create in this region")) return;

      const asset = await storage.createAsset(validatedData);
      res.json(asset);
    } catch (error) {
      sendError(res, error, "Failed to create asset");
    }
  });

  // ---------------------------------------------------------------------------
  // Snoozing an asset
  //
  // An RA confident a boiler has more life in it needs to clear it from the
  // dashboard without falsifying the date. Snooze is what makes a warning
  // system survive patchy data.
  //
  // Two things this is deliberately NOT:
  //   - it is not a permanent correction. Editing replacementDueDate is that,
  //     and this route never touches it. A snooze has an end date and returns.
  //   - it is not a way to hide an asset. Only the dashboard acts on it; the
  //     asset screen still shows it, and shows that it is snoozed.
  //
  // The reason is required, because the reason is the point -- it is what
  // makes next year's budget conversation possible.
  // ---------------------------------------------------------------------------

  /** The asset, once, with the checks both snooze routes make. */
  async function assetForSnooze(req: any, res: any, ctx: AuthContext) {
    const asset = await storage.getAsset(req.params.id);
    if (!asset) {
      res.status(404).json({ message: "Asset not found" });
      return undefined;
    }
    if (!requireRegion(res, ctx, asset.region)) return undefined;
    return asset;
  }

  app.post('/api/assets/:id/snooze', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageAssets")) return;

      const asset = await assetForSnooze(req, res, ctx);
      if (!asset) return;

      const body = z
        .object({
          // Required, so a snooze can never be permanent by omission -- and
          // bounded, so it cannot be permanent by exaggeration either. "It
          // returns" is the whole distinction from editing the replacement
          // date, and an unbounded end date erases it.
          until: z.coerce
            .date()
            // In the future by the same rule the snooze ends by, so tomorrow
            // is still tomorrow after 7pm Central (shared/dueDates.ts).
            .refine((date: Date) => !hasBegunEverywhere(date), "Pick a date in the future")
            .refine(
              (date: Date) => date.getTime() <= Date.now() + MAX_SNOOZE_DAYS * 24 * 60 * 60 * 1000,
              `A snooze can run at most ${MAX_SNOOZE_MONTHS} months. To park it for longer, correct the replacement date instead.`,
            ),
          // Required and non-blank: an unexplained snooze is just an asset
          // quietly disappearing from the one place it would have been seen.
          reason: z
            .string()
            .trim()
            .min(1, "Say why this can wait — it is what next year's budget conversation runs on")
            .max(500, "Keep the reason under 500 characters"),
        })
        .parse(req.body);

      // Only the four snooze columns. The replacement date is untouched, which
      // is what keeps a snooze from falsifying it.
      const updated = await storage.updateAsset(req.params.id, {
        snoozedUntil: body.until,
        snoozeReason: body.reason,
        snoozedByUserId: ctx.userId,
        snoozedAt: new Date(),
      });

      res.json(updated);
    } catch (error) {
      sendError(res, error, "Failed to snooze this asset");
    }
  });

  app.delete('/api/assets/:id/snooze', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageAssets")) return;

      const asset = await assetForSnooze(req, res, ctx);
      if (!asset) return;

      // The reason stays. It is the record of why somebody parked this once,
      // and that is worth keeping after the snooze itself has lapsed.
      res.json(await storage.updateAsset(req.params.id, { snoozedUntil: null }));
    } catch (error) {
      sendError(res, error, "Failed to clear the snooze");
    }
  });

  app.patch('/api/assets/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageAssets")) return;

      const existingAsset = await storage.getAsset(req.params.id);
      if (!existingAsset) {
        return res.status(404).json({ message: "Asset not found" });
      }

      const validatedData = insertAssetSchema.partial().parse(req.body);

      if (!requireRegionMove(res, ctx, existingAsset.region, validatedData.region)) return;

      const asset = await storage.updateAsset(req.params.id, validatedData);
      res.json(asset);
    } catch (error) {
      sendError(res, error, "Failed to update asset");
    }
  });

  app.delete('/api/assets/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageAssets")) return;

      const existingAsset = await storage.getAsset(req.params.id);
      if (!existingAsset) {
        return res.status(404).json({ message: "Asset not found" });
      }

      if (!requireRegion(res, ctx, existingAsset.region)) return;

      await removeDeletedRecordFiles(await storage.deleteAsset(req.params.id));
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete asset");
    }
  });

  // Middleware: rejects the request with 403 before multer reads a single byte
  // when the caller is deactivated or lacks a role that legitimately needs
  // file-storage access (residents are not permitted to upload directly).
  // Being staff is not enough on its own: an account needs a flag for one of
  // the screens that attaches files through the route, or it has nothing to
  // attach a file to. Checked here, before multer, like everything else.
  const requireUploadPermission = (...flags: PermissionName[]): import("express").RequestHandler => async (req: any, res, next) => {
    try {
      const ctx = await loadAuthContext(req);
      if (!ctx) {
        return res.status(403).json({ message: "Your account is not active." });
      }
      if (ctx.isResident) {
        return res.status(403).json({ message: "Residents are not permitted to upload files." });
      }
      if (!hasPermission(ctx, ...flags)) {
        return res.status(403).json({ message: "Forbidden - Your account cannot upload files here" });
      }
      // Handed to the upload handler so it can record who stored the file
      // without resolving the same user a second time.
      req.uploadContext = ctx;
      next();
    } catch (error) {
      sendError(res, error, "Failed to verify upload permission.");
    }
  };

  /**
   * Stores an uploaded file and records what it is.
   *
   * The key is random, so the row written here is the only place the name the
   * person chose survives, and the only link between a file and whoever put it
   * there. The bytes go first, because a row describing a file that was never
   * stored would offer a download that always fails.
   *
   * The two writes cannot be made one atomic step -- a bucket does not join a
   * database transaction -- so if the row fails the object is deleted again.
   * Without that, a failed upload would leave a file nobody has a record of:
   * invisible in the app, unreachable by name, and still taking up space.
   */
  async function storeUploadedFile(
    file: Express.Multer.File,
    actor: AuthContext,
  ): Promise<{ url: string; filename: string; originalName: string }> {
    const uploadedBy = actor.userId;
    const storageKey = generateStorageKey(file.originalname);
    const contentType = contentTypeFor(file.originalname);

    await putUpload(storageKey, file.buffer, { contentType, originalName: file.originalname });

    try {
      await storage.createUpload({
        storageKey,
        originalName: file.originalname,
        contentType,
        sizeBytes: file.size,
        uploadedBy,
      });
    } catch (error) {
      try {
        await removeUpload(storageKey);
      } catch (cleanupError) {
        // Reported, not thrown: the upload failure below is the one the caller
        // needs to hear about, and hiding it behind a cleanup error would make
        // the real problem harder to find.
        logError("Failed to remove an orphaned upload after its record could not be saved", cleanupError);
      }
      throw error;
    }

    recordAuditEvent(actor, {
      action: AUDIT_ACTIONS.DOCUMENT_UPLOADED,
      entityType: "upload",
      entityId: storageKey,
      summary: `Uploaded ${file.originalname}`,
      details: { contentType, sizeBytes: file.size },
    });

    return { url: `/uploads/${storageKey}`, filename: storageKey, originalName: file.originalname };
  }

  // File Upload Route (images)
  // The request, walkthrough, asset and house photo fields upload here.
  // Filing a request needs only the view flag, so that flag is enough.
  const IMAGE_UPLOAD_FLAGS: PermissionName[] = [
    "canViewMaintenance",
    "canManageMaintenance",
    "canManageWalkthroughs",
    "canManageAssets",
    "canManageProperties",
  ];

  app.post('/api/upload', isAuthenticated, uploadRateLimit, requireUploadPermission(...IMAGE_UPLOAD_FLAGS), ...guardedUpload(upload.single('file'), IMAGE_UPLOAD_MAX_BYTES), async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }
      // The browser-supplied MIME type is attacker-controlled; verify the
      // file's real bytes match its extension (same check as /api/upload-doc).
      if (!(await bufferMatchesExtension(req.file.buffer, req.file.originalname))) {
        return res.status(400).json({
          message: "File contents do not match the file extension. The file was not saved.",
        });
      }
      res.json(await storeUploadedFile(req.file, req.uploadContext));
    } catch (error) {
      sendError(res, error, "Failed to upload file");
    }
  });

  // Loads the auth context for an upload WITHOUT blocking residents. Used only by
  // the maintenance-request photo upload below, where a resident reporting an
  // issue is legitimately allowed to attach a photo of it.
  const attachUploadContext: import("express").RequestHandler = async (req: any, res, next) => {
    try {
      const ctx = await loadAuthContext(req);
      if (!ctx) return res.status(403).json({ message: "Your account is not active." });
      req.uploadContext = ctx;
      next();
    } catch (error) {
      sendError(res, error, "Failed to verify upload permission.");
    }
  };

  // Resident-safe image upload for maintenance-request photos. Same guards as
  // /api/upload (image-only, size-capped, content-verified) but without the
  // resident block -- a resident may attach a photo when they report an issue.
  // The upload is only visible to its uploader until a request-photo row points
  // at it, at which point it inherits the request's visibility.
  app.post('/api/maintenance-request-photos/upload', isAuthenticated, uploadRateLimit, attachUploadContext, ...guardedUpload(upload.single('file'), IMAGE_UPLOAD_MAX_BYTES), async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }
      if (!(await bufferMatchesExtension(req.file.buffer, req.file.originalname))) {
        return res.status(400).json({
          message: "File contents do not match the file extension. The file was not saved.",
        });
      }
      res.json(await storeUploadedFile(req.file, req.uploadContext));
    } catch (error) {
      sendError(res, error, "Failed to upload photo");
    }
  });

  // Document Upload Route (PDF, images, doc files up to 20MB)
  const docUpload = multer({
    storage: fileStorage,
    // See the image uploader above: one file and no extra form fields, so the
    // request cannot exceed the reservation made for it.
    limits: { fileSize: DOCUMENT_UPLOAD_MAX_BYTES, files: 1, fields: 0 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(".", "");
      // Each extension maps to the exact MIME type it must arrive with, so a
      // PDF claiming to be an image (or any other cross-pairing) is rejected.
      const extToMime: Record<string, string> = {
        pdf: "application/pdf",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        jpeg: "image/jpeg",
        jpg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
      };
      if (extToMime[ext] && file.mimetype === extToMime[ext]) {
        return cb(null, true);
      }
      cb(new Error("Only document and image files are allowed, and the file type must match the extension"));
    },
  });

  // Detect the file's real type from its contents using the maintained
  // `file-type` library (which parses container structure — e.g. it walks ZIP
  // entries to distinguish a genuine .docx from an arbitrary archive) and
  // confirm it matches what the extension claims. The browser-supplied MIME
  // type is attacker-controlled, so this content check is the one that matters.
  async function bufferMatchesExtension(buffer: Buffer, originalname: string): Promise<boolean> {
    const ext = path.extname(originalname).toLowerCase().replace(".", "");
    // Detected type (file-type's `ext`) each upload extension must resolve to.
    // Legacy .doc files are CFB (OLE2 compound file) containers.
    const expectedDetected: Record<string, string[]> = {
      pdf: ["pdf"],
      jpeg: ["jpg"],
      jpg: ["jpg"],
      png: ["png"],
      gif: ["gif"],
      webp: ["webp"],
      doc: ["cfb"],
      docx: ["docx"],
    };
    const allowed = expectedDetected[ext];
    if (!allowed) return false;
    if (ext === "docx") {
      // OOXML is a ZIP container; a generic ZIP signature is not enough and
      // string-scanning raw bytes is spoofable. Parse the ZIP central
      // directory with a real ZIP parser and require the package entries
      // every genuine .docx contains.
      try {
        const zip = new AdmZip(buffer);
        return !!zip.getEntry("[Content_Types].xml") && !!zip.getEntry("word/document.xml");
      } catch {
        return false;
      }
    }
    const detected = await fileTypeFromBuffer(buffer);
    if (!detected) return false;
    return allowed.includes(detected.ext);
  }

  // Only the billing documents (contract, COI, W-9) upload here.
  app.post('/api/upload-doc', isAuthenticated, uploadRateLimit, requireUploadPermission("canManageBilling"), ...guardedUpload(docUpload.single('file'), DOCUMENT_UPLOAD_MAX_BYTES), async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }
      if (!(await bufferMatchesExtension(req.file.buffer, req.file.originalname))) {
        return res.status(400).json({
          message: "File contents do not match the file extension. The file was not saved.",
        });
      }
      res.json(await storeUploadedFile(req.file, req.uploadContext));
    } catch (error) {
      sendError(res, error, "Failed to upload document");
    }
  });

  // The file on a comment (see "Request threads" above). Its own route rather
  // than /api/upload-doc because that one refuses residents outright, and a
  // household may attach a photo to the shared comment it may post. The
  // permission is the whole post rule -- own house, in
  // region for staff, a repair, inside the 120-day window -- run before multer
  // reads a byte. Shared is the visibility asked about because it is the one
  // both tiers may post; staff who may post internal may post shared too, so
  // the answer is the same for them. Same limits, same magic-byte check and
  // same upload layer as /api/upload-doc, so the document audit event fires
  // without this route adding one.
  const requireCommentAttachmentPermission: import("express").RequestHandler = async (req: any, res, next) => {
    try {
      const ctx = await loadAuthContext(req);
      if (!ctx) {
        return res.status(403).json({ message: "Your account is not active." });
      }
      const request = await storage.getMaintenanceRequest(req.params.id);
      if (!request) {
        return res.status(404).json({ message: "Maintenance request not found" });
      }
      const residentHouse = await residentHouseAddress(ctx);
      if (!canPostComment(ctx, request, { isInternal: false }, residentHouse)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      req.uploadContext = ctx;
      next();
    } catch (error) {
      sendError(res, error, "Failed to verify upload permission.");
    }
  };

  app.post('/api/maintenance-requests/:id/attachments', isAuthenticated, uploadRateLimit, requireCommentAttachmentPermission, ...guardedUpload(docUpload.single('file'), DOCUMENT_UPLOAD_MAX_BYTES), async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }
      if (!(await bufferMatchesExtension(req.file.buffer, req.file.originalname))) {
        return res.status(400).json({
          message: "File contents do not match the file extension. The file was not saved.",
        });
      }
      const stored = await storeUploadedFile(req.file, req.uploadContext);
      // The name is what the comment's link will say; the client keeps it
      // beside the URL until the comment is posted.
      res.json({ url: stored.url, name: stored.originalName });
    } catch (error) {
      sendError(res, error, "Failed to upload the file");
    }
  });

  // The quote on a bid (see "Bids on a project" above). Its own narrow route
  // rather than /api/upload-doc so the permission is exactly the bid write's
  // -- staff, the manage flag, the request's region, and a project rather
  // than a repair -- and it runs before multer reads a byte. Same limits,
  // same magic-byte check and same upload layer as /api/upload-doc, so the
  // document audit event fires without this route adding one.
  const requireBidDocumentPermission: RequestHandler = async (req: any, res, next) => {
    try {
      const ctx = await loadAuthContext(req);
      if (!ctx) {
        return res.status(403).json({ message: "Your account is not active." });
      }
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageMaintenance")) return;
      const request = await bidParent(res, ctx, req.params.id);
      if (!request) return;
      req.uploadContext = ctx;
      next();
    } catch (error) {
      sendError(res, error, "Failed to verify upload permission.");
    }
  };

  app.post('/api/maintenance-requests/:id/bid-documents', isAuthenticated, uploadRateLimit, requireBidDocumentPermission, ...guardedUpload(docUpload.single('file'), DOCUMENT_UPLOAD_MAX_BYTES), async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }
      if (!(await bufferMatchesExtension(req.file.buffer, req.file.originalname))) {
        return res.status(400).json({
          message: "File contents do not match the file extension. The file was not saved.",
        });
      }
      const stored = await storeUploadedFile(req.file, req.uploadContext);
      // The name is what the bid's link will say; the client keeps it beside
      // the URL until the bid is saved.
      res.json({ url: stored.url, name: stored.originalName });
    } catch (error) {
      sendError(res, error, "Failed to upload the file");
    }
  });

  // Asset Photos Routes
  app.get('/api/asset-photos', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewAssets", "canManageAssets")) return;

      const photos = await storage.getAllAssetPhotos();
      const assets = await storage.getAllAssets();

      // A photo inherits the region of the asset it documents.
      const filteredPhotos = filterByRelatedRegion(
        ctx,
        photos,
        (photo) => assets.find((a) => a.id === photo.assetId)?.region,
      );
      res.json(filteredPhotos);
    } catch (error) {
      sendError(res, error, "Failed to fetch asset photos");
    }
  });

  app.get('/api/asset-photos/asset/:assetId', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewAssets", "canManageAssets")) return;

      const asset = await storage.getAsset(req.params.assetId);
      if (!asset) {
        return res.status(404).json({ message: "Asset not found" });
      }

      if (!requireRegion(res, ctx, asset.region)) return;

      const photos = await storage.getAssetPhotosByAsset(req.params.assetId);
      res.json(photos);
    } catch (error) {
      sendError(res, error, "Failed to fetch asset photos");
    }
  });

  app.post('/api/asset-photos', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageAssets")) return;

      const validatedData = insertAssetPhotoSchema.parse(req.body);

      // A missing parent is a 404, not a silent pass: without this an unknown
      // assetId used to skip the region check entirely.
      const parentAsset = await storage.getAsset(validatedData.assetId);
      if (!parentAsset) {
        return res.status(404).json({ message: "Asset not found" });
      }
      if (!requireRegion(res, ctx, parentAsset.region, "Forbidden - Cannot create in this region")) return;
      await requireOwnUploads(ctx, validatedData, ["imageUrl"]);

      // Attribution comes from the session, never the body, so a caller cannot
      // credit a photo to someone else (matches submittedBy on requests).
      const photo = await storage.createAssetPhoto({
        ...validatedData,
        uploadedBy: ctx.user.email || "Unknown",
      });
      res.json(photo);
    } catch (error) {
      sendError(res, error, "Failed to create asset photo");
    }
  });

  app.delete('/api/asset-photos/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageAssets")) return;

      const existingPhoto = await storage.getAssetPhoto(req.params.id);
      if (!existingPhoto) {
        return res.status(404).json({ message: "Asset photo not found" });
      }

      const parentAsset = await storage.getAsset(existingPhoto.assetId);
      if (!parentAsset) {
        return res.status(404).json({ message: "Asset not found" });
      }
      if (!requireRegion(res, ctx, parentAsset.region)) return;

      await removeDeletedRecordFiles(await storage.deleteAssetPhoto(req.params.id));
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete asset photo");
    }
  });

  // Preventive & Safety Maintenance Schedules
  //
  // Schedules are maintenance work, so they reuse the maintenance permissions
  // and region scoping. region/buildingAddress are always taken from the parent
  // property, never the body, so they cannot drift from the house.
  app.get('/api/maintenance-schedules', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewMaintenance", "canManageMaintenance")) return;

      const schedules = await storage.getAllMaintenanceSchedules();
      res.json(filterByRegion(ctx, schedules));
    } catch (error) {
      sendError(res, error, "Failed to fetch maintenance schedules");
    }
  });

  app.post('/api/maintenance-schedules', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageMaintenance")) return;

      const property = await storage.getProperty(req.body.propertyId);
      if (!property) {
        return res.status(404).json({ message: "Property not found" });
      }
      if (!requireRegion(res, ctx, property.region, "Forbidden - Cannot create in this region")) return;

      // region/buildingAddress come from the property, not the caller.
      const validatedData = insertMaintenanceScheduleSchema.parse({
        ...req.body,
        region: property.region,
        buildingAddress: property.address,
      });
      const schedule = await storage.createMaintenanceSchedule(validatedData);
      res.json(schedule);
    } catch (error) {
      sendError(res, error, "Failed to create maintenance schedule");
    }
  });

  app.patch('/api/maintenance-schedules/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageMaintenance")) return;

      const existing = await storage.getMaintenanceSchedule(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Maintenance schedule not found" });
      }
      if (!requireRegion(res, ctx, existing.region)) return;

      // The house a schedule belongs to is fixed at creation, so its property and
      // therefore its region/buildingAddress are not editable here.
      const { propertyId: _p, region: _r, buildingAddress: _b, ...editable } = req.body ?? {};
      const validatedData = insertMaintenanceScheduleSchema.partial().parse(editable);
      const schedule = await storage.updateMaintenanceSchedule(req.params.id, validatedData);
      res.json(schedule);
    } catch (error) {
      sendError(res, error, "Failed to update maintenance schedule");
    }
  });

  app.delete('/api/maintenance-schedules/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageMaintenance")) return;

      const existing = await storage.getMaintenanceSchedule(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Maintenance schedule not found" });
      }
      if (!requireRegion(res, ctx, existing.region)) return;

      await storage.deleteMaintenanceSchedule(req.params.id);
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete maintenance schedule");
    }
  });

  app.post('/api/maintenance-schedules/:id/complete', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageMaintenance")) return;

      const existing = await storage.getMaintenanceSchedule(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Maintenance schedule not found" });
      }
      if (!requireRegion(res, ctx, existing.region)) return;

      const now = new Date();
      const schedule = await storage.completeMaintenanceSchedule(
        req.params.id,
        now,
        addMonths(now, existing.intervalMonths),
      );
      res.json(schedule);
    } catch (error) {
      sendError(res, error, "Failed to complete maintenance schedule");
    }
  });

  app.post('/api/maintenance-schedules/apply-template', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageMaintenance")) return;

      const property = await storage.getProperty(req.body.propertyId);
      if (!property) {
        return res.status(404).json({ message: "Property not found" });
      }
      if (!requireRegion(res, ctx, property.region, "Forbidden - Cannot create in this region")) return;

      // Skip any template whose task already exists for this house, so applying
      // twice does not create duplicates. New schedules are due now, so their
      // first completion establishes the real cadence.
      const existing = await storage.getMaintenanceSchedulesByProperty(property.id);
      const existingTitles = new Set(existing.map((s) => s.title.toLowerCase()));
      const now = new Date();
      const created = [];
      for (const template of STANDARD_SCHEDULE_TEMPLATES) {
        if (existingTitles.has(template.title.toLowerCase())) continue;
        created.push(
          await storage.createMaintenanceSchedule({
            propertyId: property.id,
            title: template.title,
            category: template.category,
            intervalMonths: template.intervalMonths,
            nextDueDate: now,
            region: property.region,
            buildingAddress: property.address,
          }),
        );
      }
      res.json({ created: created.length, schedules: created });
    } catch (error) {
      sendError(res, error, "Failed to apply the standard schedule");
    }
  });

  // Residents Routes
  //
  // The roster of who lives in each house. It is gated on the property
  // permissions -- someone who can see or manage houses can see or manage who
  // lives in them -- and region/buildingAddress are always taken from the parent
  // property, never the body, so they cannot drift from the house.
  app.get('/api/residents', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewProperties", "canManageProperties")) return;

      const roster = await storage.getAllResidents();
      res.json(filterByRegion(ctx, roster));
    } catch (error) {
      sendError(res, error, "Failed to fetch residents");
    }
  });

  app.post('/api/residents', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageProperties")) return;

      const property = await storage.getProperty(req.body.propertyId);
      if (!property) {
        return res.status(404).json({ message: "Property not found" });
      }
      if (!requireRegion(res, ctx, property.region, "Forbidden - Cannot create in this region")) return;

      // region/buildingAddress come from the property, not the caller.
      const validatedData = insertResidentSchema.parse({
        ...req.body,
        region: property.region,
        buildingAddress: property.address,
      });
      const resident = await storage.createResident(validatedData);
      res.json(resident);
    } catch (error) {
      sendError(res, error, "Failed to add resident");
    }
  });

  // ---------------------------------------------------------------------------
  // Roster CSV import
  //
  // Two endpoints, and the split between them is the whole point: the upload
  // only ever produces a preview, and a separate confirm does the writing. An
  // import that applied itself on upload would give an RA no chance to notice
  // that a column was misread or that half the sheet is already on the roster.
  //
  // The property is in the URL rather than a form field so the multipart request
  // still carries exactly one part and no text fields -- the same property the
  // other upload routes rely on to bound what a request can cost.
  // ---------------------------------------------------------------------------

  /**
   * Authorizes a roster import and resolves its property.
   *
   * This runs BEFORE multer on both routes. Doing the permission and region
   * checks after the body was read would mean a caller with no right to import
   * still gets their file buffered into memory first.
   */
  const requireRosterImportAccess: RequestHandler = async (req: any, res, next) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageProperties")) return;

      const property = await storage.getProperty(req.params.propertyId);
      if (!property) {
        return res.status(404).json({ message: "Property not found" });
      }
      if (!requireRegion(res, ctx, property.region, "Forbidden - Cannot import into this region")) return;

      req.importContext = { ctx, property };
      next();
    } catch (error) {
      sendError(res, error, "Failed to start the roster import");
    }
  };

  const csvUpload = multer({
    storage: fileStorage,
    // One file, no text fields -- see the image uploader above.
    limits: { fileSize: CSV_IMPORT_MAX_BYTES, files: 1, fields: 0 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      // Spreadsheet tools disagree about a CSV's MIME type -- Excel sends
      // application/vnd.ms-excel, some browsers send octet-stream -- so the
      // extension is the real check and the type list is deliberately broad.
      const allowedMime = new Set([
        "text/csv",
        "text/plain",
        "application/csv",
        "application/vnd.ms-excel",
        "application/octet-stream",
      ]);
      if (ext === ".csv" && allowedMime.has(file.mimetype)) {
        return cb(null, true);
      }
      cb(new Error("Only a .csv file can be imported"));
    },
  });

  /**
   * Reads the uploaded CSV as text.
   *
   * There is no magic-byte check here, unlike the document uploads, because a
   * CSV has no signature to check and -- more to the point -- nothing is
   * stored. The bytes are decoded, parsed, and dropped when the request ends,
   * so a file pretending to be a CSV gets parsed into rows that fail validation
   * rather than written anywhere.
   */
  function decodeCsv(buffer: Buffer): string | null {
    const text = buffer.toString("utf8");
    // A lone replacement character means the bytes were not UTF-8 text.
    return text.includes("\uFFFD") ? null : text;
  }

  app.post(
    '/api/properties/:propertyId/residents/import/preview',
    isAuthenticated,
    uploadRateLimit,
    requireRosterImportAccess,
    ...guardedUpload(csvUpload.single('file'), CSV_IMPORT_MAX_BYTES),
    async (req: any, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ message: "No file uploaded" });
        }
        const text = decodeCsv(req.file.buffer);
        if (text === null) {
          return res.status(400).json({ message: "That file is not readable as text. Export it as CSV and try again." });
        }

        const existing = await storage.getResidentsByProperty(req.params.propertyId);
        const preview = buildImportPreview(
          parseResidentCsv(text),
          existing.map((resident) => resident.email),
        );
        res.json(preview);
      } catch (error) {
        sendError(res, error, "Failed to read the roster file");
      }
    },
  );

  app.post(
    '/api/properties/:propertyId/residents/import',
    isAuthenticated,
    requireRosterImportAccess,
    async (req: any, res) => {
      try {
        const { property } = req.importContext;
        const { rows } = rosterImportSchema.parse(req.body);

        // The confirm step re-derives everything rather than trusting what the
        // preview said. The roster can have moved on between the two requests,
        // and the rows arrive from a client that could have edited them.
        // The row checks run again too, so a date the preview would have
        // refused is refused here rather than rolled into the next month.
        const existing = await storage.getResidentsByProperty(property.id);
        const preview = buildImportPreview(
          { rows: rows.map((row, index) => checkImportRow(index + 1, row)), fileErrors: [] },
          existing.map((resident) => resident.email),
        );
        const unusable = preview.outcomes.find((outcome) => outcome.kind === "error");
        if (unusable) {
          return res.status(400).json({ message: `Row ${unusable.row.rowNumber}: ${unusable.reason}` });
        }

        // Every row is validated before any is written, and all of them go
        // in one insert, so a failure leaves the roster as it was rather than
        // half-imported.
        const toCreate = preview.outcomes
          .filter((outcome) => outcome.kind === "create")
          .map((outcome) => insertResidentSchema.parse({
            propertyId: property.id,
            firstName: outcome.row.firstName,
            lastName: outcome.row.lastName,
            email: outcome.row.email,
            phone: outcome.row.phone,
            roomName: outcome.row.roomName,
            notes: outcome.row.notes,
            moveInDate: outcome.row.moveInDate,
            region: property.region,
            buildingAddress: property.address,
          }));
        const created = toCreate.length > 0 ? await storage.createResidents(toCreate) : [];

        res.json({
          created: created.length,
          skipped: preview.counts.duplicate,
          residents: created,
        });
      } catch (error) {
        sendError(res, error, "Failed to import the roster");
      }
    },
  );

  app.patch('/api/residents/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageProperties")) return;

      const existing = await storage.getResident(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Resident not found" });
      }
      if (!requireRegion(res, ctx, existing.region)) return;

      // The house a resident belongs to is fixed here, so its property and
      // therefore its region/buildingAddress are not editable.
      const { propertyId: _p, region: _r, buildingAddress: _b, ...editable } = req.body ?? {};
      const validatedData = insertResidentSchema.partial().parse(editable);
      // A person's edit: the sheet sync flags it if the sheet later changes it.
      const resident = await storage.updateResident(req.params.id, validatedData, { by: ctx.user.email ?? null, at: new Date() });
      // A stop date ends household login access and rent charging, so changing
      // it is on the record, old and new, never a silent overwrite (#260).
      if (validatedData.moveOutDate !== undefined) {
        const stopDay = (d: Date | null) => (d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null);
        const from = stopDay(existing.moveOutDate);
        const to = stopDay(validatedData.moveOutDate);
        if (from !== to) {
          const change = to === null ? `Cleared the stop date (was ${from})` : from === null ? `Set the stop date to ${to}` : `Changed the stop date from ${from} to ${to}`;
          recordAuditEvent(ctx, {
            action: AUDIT_ACTIONS.RESIDENT_STOP_DATE_CHANGED,
            entityType: "resident",
            entityId: existing.id,
            summary: `${change} for ${existing.firstName} ${existing.lastName} at ${existing.buildingAddress}`,
            details: { from, to, propertyId: existing.propertyId, region: existing.region },
          });
        }
      }
      // Marked moved out, or a stop date already past: their household login ends now.
      await closeDepartedHouseholdLogins({ propertyId: existing.propertyId });
      res.json(resident);
    } catch (error) {
      sendError(res, error, "Failed to update resident");
    }
  });

  // The portal login a roster row speaks for: an active resident login with
  // the row's exact email (case aside) that is linked to the row's own house.
  // A login elsewhere is not this row's to report on or switch off, even if a
  // roster email was typed to match it. /api/my-property applies the same
  // rule the other way round before it hands a login the house's codes.
  async function loginForRosterRow(resident: { email: string; propertyId: string | null }) {
    const account = await storage.getActiveResidentAccountByEmail(resident.email);
    if (!account || !rosterRowSpeaksFor(resident, account)) return undefined;
    return account;
  }

  // Whether a roster resident has an active portal login, so the move-out
  // dialog can offer to switch it off. Same guards as the move-out itself.
  app.get('/api/residents/:id/account-status', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageProperties")) return;

      const resident = await storage.getResident(req.params.id);
      if (!resident) {
        return res.status(404).json({ message: "Resident not found" });
      }
      if (!requireRegion(res, ctx, resident.region)) return;

      const account = await loginForRosterRow(resident);
      res.json({ hasActiveAccount: !!account });
    } catch (error) {
      sendError(res, error, "Failed to check the resident's account");
    }
  });

  // Move-out as one deliberate action: the roster row is closed on the chosen
  // date, and optionally the person's portal login is switched off with it.
  // Since house-wide visibility shipped, an active login keeps seeing the
  // house's requests after its owner leaves — this is where that ends.
  app.post('/api/residents/:id/move-out', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageProperties")) return;

      const { moveOutDate, deactivateAccount } = z
        .object({
          moveOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date"),
          deactivateAccount: z.boolean(),
        })
        .parse(req.body);

      const resident = await storage.getResident(req.params.id);
      if (!resident) {
        return res.status(404).json({ message: "Resident not found" });
      }
      if (!requireRegion(res, ctx, resident.region)) return;

      // The day they left, not a plan: recording it switches off their portal
      // login and drops them from the house now. A coming leaving date is the
      // stop date on their roster record, which keeps them in until that day.
      // One day of slack for the reader's evening, when UTC is already tomorrow.
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      if (moveOutDate > tomorrow) {
        return res.status(400).json({
          message: "Record a move-out on or after the day they leave. To plan ahead, set their stop date from Edit on their roster record instead.",
        });
      }

      // Through the shared schema so the date string becomes a Date the same
      // way every other resident write does.
      const updated = await storage.updateResident(
        req.params.id,
        insertResidentSchema.partial().parse({ isActive: false, moveOutDate }),
        { by: ctx.user.email ?? null, at: new Date() },
      );

      // Bounded on purpose: only an *active, resident-role* login with this
      // roster row's email and linked to its house can be switched off here,
      // and this route only ever deactivates. Reactivation stays an admin
      // action in Settings.
      let accountDeactivated = false;
      if (deactivateAccount) {
        const account = await loginForRosterRow(resident);
        if (account) {
          // The house link is what reaches the house's requests, walkthroughs
          // and codes, so it goes with the login, in the same write:
          // reactivating the account later must not hand the old house back.
          await storage.deactivateAndUnlinkUser(account.id);
          accountDeactivated = true;
          recordAuditEvent(ctx, {
            action: AUDIT_ACTIONS.USER_STATUS_CHANGED,
            entityType: "user",
            entityId: account.id,
            summary: `Deactivated ${accountName(account)}'s login while moving them out of ${resident.buildingAddress}`,
            details: { isActive: false, reason: "move_out", residentId: resident.id },
          });
          recordAuditEvent(ctx, {
            action: AUDIT_ACTIONS.USER_PROPERTY_CHANGED,
            entityType: "user",
            entityId: account.id,
            summary: `Unlinked ${accountName(account)} from their house while moving them out of ${resident.buildingAddress}`,
            details: { from: account.propertyId ?? null, to: null, reason: "move_out", residentId: resident.id },
          });
        }
      }

      // Whatever the dialog asked, a household login ends with the stay
      // (JR, 2026-10-01); the switch-off above has already audited it with
      // the RA as the actor when it was ticked.
      accountDeactivated = (await closeDepartedHouseholdLogins({ propertyId: resident.propertyId })) > 0 || accountDeactivated;
      res.json({ resident: updated, accountDeactivated });
    } catch (error) {
      sendError(res, error, "Failed to move the resident out");
    }
  });

  app.delete('/api/residents/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageProperties")) return;

      const existing = await storage.getResident(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Resident not found" });
      }
      if (!requireRegion(res, ctx, existing.region)) return;

      const files = await storage.deleteResident(req.params.id);
      await closeDepartedHouseholdLogins({ propertyId: existing.propertyId });
      // Its move-out photos went with it by cascade.
      await removeDeletedRecordFiles(files);

      // The roster row goes and its HH fee charges, deposits and paperwork go
      // with it by cascade, so this is the only record left that the person
      // was ever on it.
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.RESIDENT_DELETED,
        entityType: "resident",
        entityId: existing.id,
        summary: `Removed ${existing.firstName} ${existing.lastName} from the roster at ${existing.buildingAddress}`,
        details: { propertyId: existing.propertyId, isActive: existing.isActive, region: existing.region },
      });

      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to remove resident");
    }
  });

  // Resident Finances: rent payments and security deposits
  //
  // Finance data is staff-only and, within staff, gated by the finance
  // permission flags. Issue #43 originally decided against a separate finance
  // permission (staff were exactly the finance audience); the flags supersede
  // that so finance can later be split out of admin by revoking a grant rather
  // than rewriting guards. Existing staff were backfilled with both flags, and
  // admins bypass as everywhere. Residents are refused outright, everything is
  // region-scoped, and propertyId/region/buildingAddress are always taken from
  // the resident (which already carries them), never the body.
  app.get('/api/rent-payments', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewFinancials", "canManageFinancials")) return;

      const payments = await storage.getAllRentPayments();
      res.json(filterByRegion(ctx, payments));
    } catch (error) {
      sendError(res, error, "Failed to fetch rent payments");
    }
  });

  app.post('/api/rent-payments', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageFinancials")) return;

      const resident = await storage.getResident(req.body.residentId);
      if (!resident) {
        return res.status(404).json({ message: "Resident not found" });
      }
      if (!requireRegion(res, ctx, resident.region, "Forbidden - Cannot record in this region")) return;

      const validatedData = insertRentPaymentSchema.parse({
        ...req.body,
        propertyId: resident.propertyId,
        region: resident.region,
        buildingAddress: resident.buildingAddress,
      });
      const payment = await storage.createRentPayment(validatedData);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.RENT_PAYMENT_CREATED,
        entityType: "rent_payment",
        entityId: payment.id,
        summary: `Recorded ${payment.period} HH fees of ${payment.amount ?? "an unstated amount"} for a resident at ${payment.buildingAddress} (${payment.status})`,
        details: { residentId: payment.residentId, period: payment.period, amount: payment.amount ?? null, status: payment.status, region: payment.region },
      });

      res.json(payment);
    } catch (error) {
      sendError(res, error, "Failed to record rent payment");
    }
  });

  // Records a month's rent for a whole house in one action: an unpaid charge for
  // every current resident who does not already have one for that month. The
  // amount is "flat per house" -- taken from the body, or defaulted to the last
  // amount charged for the house so it need not be retyped each month.
  app.post('/api/rent-payments/generate', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageFinancials")) return;

      const { propertyId, period } = req.body ?? {};
      if (!RENT_PERIOD_PATTERN.test(period ?? "")) {
        return res.status(400).json({ message: "Use a YYYY-MM month" });
      }
      const property = await storage.getProperty(propertyId);
      if (!property) {
        return res.status(404).json({ message: "Property not found" });
      }
      if (!requireRegion(res, ctx, property.region, "Forbidden - Cannot record in this region")) return;

      const amount = req.body.amount ?? (await storage.getLatestRentAmountForProperty(property.id));
      if (amount === undefined || amount === null || amount === "") {
        return res.status(400).json({ message: "Enter an amount -- there are no previous HH fees for this house to copy." });
      }

      const roster = await storage.getResidentsByProperty(property.id);
      // Current means active and not past the stop date: nothing flips
      // isActive when a stop date passes (#260).
      const current = roster.filter((r) => isCurrentResident(r));
      const created = [];
      for (const resident of current) {
        const existing = await storage.getRentPaymentForResidentPeriod(resident.id, period);
        if (existing) continue;
        const payment = await storage.createRentPayment(
          insertRentPaymentSchema.parse({
            residentId: resident.id,
            propertyId: property.id,
            period,
            amount,
            region: property.region,
            buildingAddress: property.address,
          }),
        );
        created.push(payment);
        recordAuditEvent(ctx, {
          action: AUDIT_ACTIONS.RENT_PAYMENT_CREATED,
          entityType: "rent_payment",
          entityId: payment.id,
          summary: `Recorded ${payment.period} HH fees of ${payment.amount ?? "an unstated amount"} for a resident at ${payment.buildingAddress} (${payment.status})`,
          details: { residentId: payment.residentId, period: payment.period, amount: payment.amount ?? null, status: payment.status, region: payment.region, viaGenerate: true },
        });
      }
      res.json({ created: created.length, payments: created });
    } catch (error) {
      sendError(res, error, "Failed to record rent for the house");
    }
  });

  app.patch('/api/rent-payments/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageFinancials")) return;

      const existing = await storage.getRentPayment(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "HH fee payment not found" });
      }
      if (!requireRegion(res, ctx, existing.region)) return;

      // The resident, house, month and region are fixed once a charge exists;
      // only its status and payment details are editable here.
      const { residentId: _r, propertyId: _p, period: _pe, region: _re, buildingAddress: _b, ...editable } = req.body ?? {};
      const validatedData = insertRentPaymentSchema.partial().parse(editable);
      const payment = await storage.updateRentPayment(req.params.id, validatedData);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.RENT_PAYMENT_UPDATED,
        entityType: "rent_payment",
        entityId: req.params.id,
        summary: `Updated ${existing.period} HH fees for a resident at ${existing.buildingAddress} (now ${payment.status})`,
        details: {
          changed: changedFields(existing as unknown as Record<string, unknown>, validatedData),
          status: payment.status,
          amount: payment.amount ?? null,
        },
      });

      res.json(payment);
    } catch (error) {
      sendError(res, error, "Failed to update rent payment");
    }
  });

  app.delete('/api/rent-payments/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageFinancials")) return;

      const existing = await storage.getRentPayment(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "HH fee payment not found" });
      }
      if (!requireRegion(res, ctx, existing.region)) return;

      await storage.deleteRentPayment(req.params.id);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.RENT_PAYMENT_DELETED,
        entityType: "rent_payment",
        entityId: req.params.id,
        summary: `Deleted ${existing.period} HH fees of ${existing.amount ?? "an unstated amount"} for a resident at ${existing.buildingAddress}`,
        details: { residentId: existing.residentId, period: existing.period, amount: existing.amount ?? null, status: existing.status, region: existing.region },
      });

      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete rent payment");
    }
  });

  app.get('/api/security-deposits', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewFinancials", "canManageFinancials")) return;

      const deposits = await storage.getAllSecurityDeposits();
      res.json(filterByRegion(ctx, deposits));
    } catch (error) {
      sendError(res, error, "Failed to fetch security deposits");
    }
  });

  app.post('/api/security-deposits', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageFinancials")) return;

      const resident = await storage.getResident(req.body.residentId);
      if (!resident) {
        return res.status(404).json({ message: "Resident not found" });
      }
      if (!requireRegion(res, ctx, resident.region, "Forbidden - Cannot record in this region")) return;

      // One deposit per resident.
      const already = await storage.getSecurityDepositByResident(resident.id);
      if (already) {
        return res.status(409).json({ message: "This resident already has a deposit on file." });
      }

      const validatedData = insertSecurityDepositSchema.parse({
        ...req.body,
        propertyId: resident.propertyId,
        region: resident.region,
        buildingAddress: resident.buildingAddress,
      });
      if (returnedExceedsHeld(validatedData.amountHeld, validatedData.amountReturned)) {
        return res.status(400).json({ message: RETURNED_OVER_HELD });
      }
      const deposit = await storage.createSecurityDeposit(validatedData);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.SECURITY_DEPOSIT_CREATED,
        entityType: "security_deposit",
        entityId: deposit.id,
        summary: `Recorded a security deposit of ${deposit.amountHeld ?? "an unstated amount"} for a resident at ${deposit.buildingAddress} (${deposit.status})`,
        details: { residentId: deposit.residentId, amountHeld: deposit.amountHeld ?? null, status: deposit.status, region: deposit.region },
      });

      res.json(deposit);
    } catch (error) {
      sendError(res, error, "Failed to record security deposit");
    }
  });

  app.patch('/api/security-deposits/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageFinancials")) return;

      const existing = await storage.getSecurityDeposit(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Security deposit not found" });
      }
      if (!requireRegion(res, ctx, existing.region)) return;

      const { residentId: _r, propertyId: _p, region: _re, buildingAddress: _b, ...editable } = req.body ?? {};
      const validatedData = insertSecurityDepositSchema.partial().parse(editable);
      const held = validatedData.amountHeld !== undefined ? validatedData.amountHeld : existing.amountHeld;
      const returned = validatedData.amountReturned !== undefined ? validatedData.amountReturned : existing.amountReturned;
      if (returnedExceedsHeld(held, returned)) {
        return res.status(400).json({ message: RETURNED_OVER_HELD });
      }
      const deposit = await storage.updateSecurityDeposit(req.params.id, validatedData);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.SECURITY_DEPOSIT_UPDATED,
        entityType: "security_deposit",
        entityId: req.params.id,
        summary: `Updated a security deposit for a resident at ${existing.buildingAddress} (now ${deposit.status})`,
        details: {
          changed: changedFields(existing as unknown as Record<string, unknown>, validatedData),
          status: deposit.status,
          amountHeld: deposit.amountHeld ?? null,
          amountReturned: deposit.amountReturned ?? null,
        },
      });

      res.json(deposit);
    } catch (error) {
      sendError(res, error, "Failed to update security deposit");
    }
  });

  app.delete('/api/security-deposits/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageFinancials")) return;

      const existing = await storage.getSecurityDeposit(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Security deposit not found" });
      }
      if (!requireRegion(res, ctx, existing.region)) return;

      await storage.deleteSecurityDeposit(req.params.id);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.SECURITY_DEPOSIT_DELETED,
        entityType: "security_deposit",
        entityId: req.params.id,
        summary: `Deleted a security deposit of ${existing.amountHeld ?? "an unstated amount"} for a resident at ${existing.buildingAddress}`,
        details: { residentId: existing.residentId, amountHeld: existing.amountHeld ?? null, status: existing.status, region: existing.region },
      });

      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete security deposit");
    }
  });

  // ---------------------------------------------------------------------------
  // Deposit deductions
  //
  // SPO HOLDS a deposit per resident and records deductions against that
  // person. The portal is a ledger and a reminder -- the money moves in
  // QuickBooks and Ramp. Amounts, dates, descriptions and references only,
  // never anything that could move money.
  //
  // Visibility is admins and the finance team ONLY. Residents never see
  // deposits, deductions, balances or statements, and household leader and
  // steward accounts see none of it either -- which is why every route here
  // carries requireStaff on top of the finance flag.
  // ---------------------------------------------------------------------------

  /** The resident, once, with the checks every deduction route makes. */
  async function residentForDeduction(res: any, ctx: AuthContext, residentId: string) {
    const resident = await storage.getResident(residentId);
    if (!resident) {
      res.status(404).json({ message: "Resident not found" });
      return undefined;
    }
    if (!requireRegion(res, ctx, resident.region)) return undefined;
    return resident;
  }

  /**
   * One walkthrough item is charged once. The worksheet's "already charged"
   * skip lives in the browser, so two tabs or two finance staff could each
   * charge the same item; the server is what refuses the second (#262).
   * Passes (and does nothing) for a charge with no walkthrough item.
   */
  async function requireItemNotCharged(res: any, walkthroughItemId: string | null | undefined) {
    if (!walkthroughItemId) return true;
    const existing = await storage.getDepositDeductionsByWalkthroughItem(walkthroughItemId);
    if (existing.length === 0) return true;
    res.status(409).json({ message: "That walkthrough item has already been charged. Edit or delete the earlier charge instead." });
    return false;
  }

  /** One line for the trail. Names the person and the amount, as money should. */
  const deductionSummary = (
    verb: string,
    resident: { firstName: string; lastName: string },
    description: string,
    amount: string,
  ) => `${verb} a ${amount} deposit deduction for ${resident.firstName} ${resident.lastName}: ${description}`;

  app.get('/api/deposit-deductions', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewFinancials", "canManageFinancials")) return;

      res.json(filterByRegion(ctx, await storage.getAllDepositDeductions()));
    } catch (error) {
      sendError(res, error, "Failed to fetch deposit deductions");
    }
  });

  app.post('/api/deposit-deductions', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageFinancials")) return;

      const body = insertDepositDeductionSchema.parse(req.body);

      const resident = await residentForDeduction(res, ctx, body.residentId);
      if (!resident) return;

      if (!(await requireItemNotCharged(res, body.walkthroughItemId))) return;

      // The region and the house come from the resident, and the actor from
      // the session. None of the three is ever taken from the body.
      const deduction = await storage.createDepositDeduction({
        ...body,
        propertyId: resident.propertyId,
        region: resident.region,
        buildingAddress: resident.buildingAddress,
        recordedByUserId: ctx.userId,
        recordedByEmail: ctx.user.email ?? null,
      });

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.DEPOSIT_DEDUCTION_ADDED,
        entityType: "deposit_deduction",
        entityId: deduction.id,
        summary: deductionSummary("Added", resident, body.description, body.amount),
        details: { residentId: resident.id, amount: body.amount, region: resident.region },
      });

      res.json(deduction);
    } catch (error) {
      sendError(res, error, "Failed to record the deduction");
    }
  });

  /**
   * A common-area charge, divided across a house.
   *
   * A hole in a common room has to be split across the people living there.
   * Two things about how this is stored decide whether the ledger stays
   * trustworthy:
   *
   *   - **The result is individual per-person line items**, never a shared
   *     charge with a divisor. A later edit must not silently re-divide
   *     somebody's already-settled balance. `splitGroupId` is kept for
   *     provenance and display, and nothing ever recomputes from it.
   *   - **The whole split is written in one call.** A half-applied split
   *     leaves some of a house charged and some not, and the shares no longer
   *     adding up to the charge.
   *
   * The RA names who is on the hook, having seen and edited the split first --
   * so the request is the truth about that, not the roster. Where damage is
   * attributable to one person, they use the single-deduction route instead.
   */
  app.post('/api/deposit-deductions/split', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageFinancials")) return;

      const body = z
        .object({
          propertyId: z.string().min(1),
          description: z
            .string()
            .trim()
            .min(1, "Say what the charge is for")
            .max(300, "Keep the description under 300 characters")
            // The financial-data rule, as on a single deduction (#51).
            .pipe(financeText),
          amount: z.coerce.number().finite().min(0, "Must be 0 or greater").refine(isWholeCents, WHOLE_CENTS_MESSAGE),
          chargeDate: z.coerce.date(),
          residentIds: z
            .array(z.string().min(1))
            .min(1, "Choose at least one person to split this across")
            // A name twice is two shares of one charge on one person.
            .refine((ids) => new Set(ids).size === ids.length, "Each person can be in a split only once"),
          // The same loose links the single-deduction route accepts, so a
          // split raised from the move-out worksheet stays traceable to the
          // walkthrough item that found the damage.
          walkthroughItemId: z.string().min(1).nullish(),
          maintenanceRequestId: z.string().min(1).nullish(),
        })
        .parse(req.body);

      const property = await storage.getProperty(body.propertyId);
      if (!property) {
        return res.status(404).json({ message: "Property not found" });
      }
      if (!requireRegion(res, ctx, property.region)) return;

      if (!(await requireItemNotCharged(res, body.walkthroughItemId))) return;

      // Everybody charged has to actually live here. Without this a split
      // becomes a way to write a deduction against somebody in a region the
      // caller cannot reach.
      const roster = await storage.getResidentsByProperty(property.id);
      const byId = new Map(roster.map((resident) => [resident.id, resident]));
      const people = body.residentIds.map((id) => byId.get(id));
      if (people.some((person) => !person)) {
        return res.status(400).json({ message: "Everybody in a split has to live in that house" });
      }

      // Cents, not dollars: splitting in floating-point is how
      // 33.333333333333336 ends up on a worksheet finance acts on.
      const shares = splitEvenly(toCents(body.amount), people.length);
      const splitGroupId = randomUUID();

      const rows = people.map((person, index) => ({
        residentId: person!.id,
        propertyId: property.id,
        description: body.description,
        amount: fromCents(shares[index]),
        chargeDate: body.chargeDate,
        splitGroupId,
        walkthroughItemId: body.walkthroughItemId ?? null,
        maintenanceRequestId: body.maintenanceRequestId ?? null,
        region: property.region,
        buildingAddress: property.address,
        recordedByUserId: ctx.userId,
        recordedByEmail: ctx.user.email ?? null,
      }));

      const created = await storage.createDepositDeductions(rows);

      // One event per person, because one person's balance changing is the
      // thing somebody may later have to account for.
      people.forEach((person, index) => {
        recordAuditEvent(ctx, {
          action: AUDIT_ACTIONS.DEPOSIT_DEDUCTION_ADDED,
          entityType: "deposit_deduction",
          entityId: created[index]?.id ?? null,
          summary: deductionSummary("Added", person!, body.description, fromCents(shares[index])),
          details: {
            residentId: person!.id,
            amount: fromCents(shares[index]),
            splitGroupId,
            splitAcross: people.length,
            region: property.region,
          },
        });
      });

      res.json(created);
    } catch (error) {
      sendError(res, error, "Failed to split the charge");
    }
  });

  app.patch('/api/deposit-deductions/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageFinancials")) return;

      const existing = await storage.getDepositDeduction(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Deduction not found" });
      }
      if (!requireRegion(res, ctx, existing.region)) return;

      // residentId is not editable: moving a deduction between people is two
      // separate acts on two separate balances, and the trail should say so.
      // walkthroughItemId is not editable either: an item takes one charge
      // group only (#262), and re-pointing a deduction would defeat that.
      const body = insertDepositDeductionSchema.partial().omit({ residentId: true, walkthroughItemId: true }).parse(req.body);

      const updated = await storage.updateDepositDeduction(req.params.id, body);
      const resident = await storage.getResident(existing.residentId);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.DEPOSIT_DEDUCTION_UPDATED,
        entityType: "deposit_deduction",
        entityId: req.params.id,
        summary: deductionSummary(
          "Changed",
          resident ?? { firstName: "a former", lastName: "resident" },
          updated.description,
          updated.amount,
        ),
        details: { fields: changedFields(existing as unknown as Record<string, unknown>, body as Record<string, unknown>), region: existing.region },
      });

      res.json(updated);
    } catch (error) {
      sendError(res, error, "Failed to update the deduction");
    }
  });

  app.delete('/api/deposit-deductions/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageFinancials")) return;

      const existing = await storage.getDepositDeduction(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Deduction not found" });
      }
      if (!requireRegion(res, ctx, existing.region)) return;

      await storage.deleteDepositDeduction(req.params.id);
      const resident = await storage.getResident(existing.residentId);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.DEPOSIT_DEDUCTION_DELETED,
        entityType: "deposit_deduction",
        entityId: req.params.id,
        summary: deductionSummary(
          "Removed",
          resident ?? { firstName: "a former", lastName: "resident" },
          existing.description,
          existing.amount,
        ),
        details: { residentId: existing.residentId, amount: existing.amount, region: existing.region },
      });

      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to remove the deduction");
    }
  });

  // ---------------------------------------------------------------------------
  // Resource hub, liability paperwork and startup budgets
  //
  // The hub is the one page a household leader or steward needs to go to, and
  // it is the widest resident-facing surface in the portal. Two rules hold it:
  //
  //   - **A resident's scope is their HOUSE's region**, resolved from their
  //     property, never from whatever a permissions row happens to say. A
  //     resident-tier account has no region path anywhere else and acquires
  //     none here.
  //   - **Managing the links is admin-only.** A national link reaches every
  //     region, exactly as the walkthrough template does, so it takes the same
  //     grant -- a regional flag is a grant over your own houses.
  //
  // No financial information belongs on this page. A startup budget is an
  // OPERATING figure -- what a house has to furnish and settle itself -- and
  // is not deposit or rent data, which is why a leader may see their own.
  // ---------------------------------------------------------------------------

  /**
   * The regions whose material this caller should see.
   *
   * Null entries mean "national", which everybody gets. A resident resolves to
   * their own house's region and nothing else; a resident with no house claim
   * falls back to the national material alone rather than to nothing -- a
   * leader with a broken property link should still find the fire extinguisher
   * guidance.
   */
  async function readableRegions(ctx: AuthContext): Promise<{ all: boolean; regions: string[] }> {
    if (ctx.isAdmin) return { all: true, regions: [] };
    if (ctx.isResident) {
      const propertyId = ctx.user.propertyId;
      if (!propertyId) return { all: false, regions: [] };
      const property = await storage.getProperty(propertyId);
      return { all: false, regions: property?.region ? [property.region] : [] };
    }
    return { all: false, regions: ctx.allowedRegions };
  }

  /**
   * The signed-in resident's own house, and only the parts they should read.
   *
   * A resident cannot read `/api/properties` — that list is staff-only — but
   * the resource hub needs their lease link and the house's name. So this is a
   * deliberately narrow projection of one property: **it returns named fields
   * rather than the row**, so a column added to `properties` later cannot
   * silently start reaching a resident.
   *
   * Nothing financial is on it. The startup budget has its own route and its
   * own reasoning; the deposit figure is not exposed here at all.
   */
  app.get('/api/my-property', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      // Staff have the full property list; this route exists for the tier that
      // does not, and answers null rather than pretending otherwise.
      if (!ctx.isResident) return res.json(null);
      // The hub's own grant. A resident-tier capability is gated on a flag,
      // exactly as walkthrough completion is.
      if (!requirePermission(res, ctx, "canViewResourceHub")) return;
      if (!ctx.user.propertyId) return res.json(null);

      const property = await storage.getProperty(ctx.user.propertyId);
      if (!property) return res.json(null);

      // The codes go to the household, and the household is the house's
      // roster today: an active row at this house with this login's exact
      // email (the move-out rule) whose stop date has not passed. The house link alone is not enough -- a
      // login linked and never rostered, removed from the roster, or moved
      // out without its login switched off keeps the rest of this card but
      // not the codes.
      const onRoster = (await storage.getResidentsByProperty(property.id)).some((row) => isCurrentRosterMember(row, ctx.user));

      // The house facts (ADR-0002) reach the household through this projection
      // and nothing else: named fields again, so `notes` -- the staff-only
      // remarks -- can never ride along. Who to call and the portal come from
      // the property's own columns, and only for a house SPO does not own.
      const [facts, landlord] = await Promise.all([
        onRoster ? storage.getPropertyFacts(property.id) : undefined,
        property.ownership === "rented" && property.rentalCompanyContactId
          ? storage.getMaintenanceContact(property.rentalCompanyContactId)
          : undefined,
      ]);

      res.json({
        id: property.id,
        name: property.name,
        address: property.address,
        leaseDocumentUrl: property.leaseDocumentUrl,
        maintenancePortalUrl: property.ownership === "rented" ? property.maintenancePortalUrl : null,
        rentalCompany: landlord
          ? { name: landlord.name, company: landlord.company, phone: landlord.phone }
          : null,
        facts: facts
          ? {
              doorCode: facts.doorCode,
              doorCodeUpdatedAt: facts.doorCodeUpdatedAt,
              gateCode: facts.gateCode,
              gateCodeUpdatedAt: facts.gateCodeUpdatedAt,
              alarmCode: facts.alarmCode,
              alarmCodeUpdatedAt: facts.alarmCodeUpdatedAt,
              securityNotes: facts.securityNotes,
              parkingRules: facts.parkingRules,
              surfaceCare: facts.surfaceCare,
              doNots: facts.doNots,
              rubbishDay: facts.rubbishDay,
              otherNotes: facts.otherNotes,
            }
          : null,
      });
    } catch (error) {
      sendError(res, error, "Failed to fetch your house");
    }
  });

  app.get('/api/resource-links', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      // The third layer, both tiers. A resident-tier capability is gated on
      // its own flag -- `canViewResourceHub`, not `canCompleteWalkthroughs`,
      // because those are different grants and honouring one for the other
      // means a later change to either silently moves the other. Staff read it
      // under the property permission, so they can see what their households
      // are being told.
      if (
        !requirePermission(
          res,
          ctx,
          ...(ctx.isResident
            ? (["canViewResourceHub"] as const)
            : (["canViewProperties", "canManageProperties"] as const)),
        )
      ) {
        return;
      }

      const scope = await readableRegions(ctx);
      const allowed = normalizeRegions(scope.regions);
      const links = (await storage.getAllResourceLinks()).filter((link) => {
        // A hidden link stays visible to an admin, who is the only person who
        // can hide one -- otherwise hiding it would be indistinguishable from
        // deleting it, with no way back.
        if (!link.isActive) return ctx.isAdmin;
        // Null region means national -- everybody, including a resident whose
        // house link is missing.
        if (!link.region) return true;
        if (scope.all) return true;
        if (allowed.includes("all")) return true;
        return allowed.includes(normalizeRegion(link.region));
      });

      res.json(links);
    } catch (error) {
      sendError(res, error, "Failed to fetch the resource links");
    }
  });

  app.post('/api/resource-links', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const link = insertResourceLinkSchema.parse(req.body);
      // A named slot is national and has one holder -- see
      // shared/resourceHubSlots.ts. The unique index is the backstop; this is
      // the message a person can act on.
      const problem = link.slotKey ? hubSlotProblem(link, await storage.getAllResourceLinks()) : null;
      if (problem) return res.status(400).json({ message: problem });

      res.json(await storage.createResourceLink(link));
    } catch (error) {
      sendError(res, error, "Failed to add the link");
    }
  });

  app.patch('/api/resource-links/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const existing = await storage.getResourceLink(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Link not found" });
      }

      const patch = insertResourceLinkSchema.partial().parse(req.body);
      // Checked over the merged row: an edit sends only the field it changes,
      // so narrowing a slotted link to one region arrives with no slotKey.
      const merged = { ...existing, ...patch };
      const problem = merged.slotKey ? hubSlotProblem(merged, await storage.getAllResourceLinks()) : null;
      if (problem) return res.status(400).json({ message: problem });

      res.json(await storage.updateResourceLink(req.params.id, patch));
    } catch (error) {
      sendError(res, error, "Failed to update the link");
    }
  });

  app.delete('/api/resource-links/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const existing = await storage.getResourceLink(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Link not found" });
      }

      await storage.deleteResourceLink(req.params.id);
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to remove the link");
    }
  });

  // ── Liability paperwork ───────────────────────────────────────────────────

  app.get('/api/resident-documents', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewProperties", "canManageProperties")) return;

      res.json(filterByRegion(ctx, await storage.getAllResidentDocuments()));
    } catch (error) {
      sendError(res, error, "Failed to fetch paperwork");
    }
  });

  /**
   * Records that a document was signed, and when.
   *
   * **This is not e-signature.** An RA records what happened on paper; the
   * signing happens wherever SPO already does it. Staff-only for the same
   * reason: a resident marking their own waiver signed would be the record
   * certifying itself.
   *
   * Clearing the date is allowed, because correcting a mistake has to be
   * possible — the row existing is not evidence, only a date is.
   */
  app.put('/api/residents/:residentId/documents/:documentKey', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageProperties")) return;

      const resident = await storage.getResident(req.params.residentId);
      if (!resident) {
        return res.status(404).json({ message: "Resident not found" });
      }
      if (!requireRegion(res, ctx, resident.region)) return;

      // The list is fixed in code, so an unknown key is a client error rather
      // than a new row: accepting it would write something no summary reads.
      if (!isKnownResidentDocument(req.params.documentKey)) {
        return res.status(400).json({ message: "Unknown document" });
      }

      const body = insertResidentDocumentSchema.parse(req.body);

      const record = await storage.setResidentDocument(resident.id, req.params.documentKey, {
        signedOn: body.signedOn ?? null,
        notes: body.notes ?? null,
        region: resident.region,
        recordedByUserId: ctx.userId,
        recordedByEmail: ctx.user.email ?? null,
      });

      // This row is what gets cited in a dispute, and it is an upsert -- so
      // without an event the only record of who set it previously is the row
      // this one just overwrote.
      const documentLabel =
        RESIDENT_DOCUMENTS.find((document) => document.key === req.params.documentKey)?.label ??
        req.params.documentKey;
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.RESIDENT_DOCUMENT_RECORDED,
        entityType: "resident",
        entityId: resident.id,
        summary: body.signedOn
          ? `Recorded ${resident.firstName} ${resident.lastName}'s ${documentLabel} as signed`
          : `Cleared the signed date on ${resident.firstName} ${resident.lastName}'s ${documentLabel}`,
        details: { documentKey: req.params.documentKey, signed: !!body.signedOn, region: resident.region },
      });

      res.json(record);
    } catch (error) {
      sendError(res, error, "Failed to record the paperwork");
    }
  });

  // ── Startup budgets ───────────────────────────────────────────────────────

  app.get('/api/property-budgets', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      // The third layer, both tiers. The startup budget is shown on the hub,
      // so a resident reaches it under the hub's grant; staff under the
      // property permission.
      if (
        !requirePermission(
          res,
          ctx,
          ...(ctx.isResident
            ? (["canViewResourceHub"] as const)
            : (["canViewProperties", "canManageProperties"] as const)),
        )
      ) {
        return;
      }

      // A leader sees their own house's figure and nobody else's -- narrowed
      // by PROPERTY, not by region, so being in the same region as another
      // house grants nothing -- and only while they are on its roster.
      if (ctx.isResident) {
        const house = await residentHouse(ctx);
        if (!house) return res.json([]);
        const budgets = await storage.getAllPropertyBudgets();
        return res.json(budgets.filter((budget) => budget.propertyId === house.id));
      }

      res.json(filterByRegion(ctx, await storage.getAllPropertyBudgets()));
    } catch (error) {
      sendError(res, error, "Failed to fetch startup budgets");
    }
  });

  app.put('/api/properties/:propertyId/budget', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageProperties")) return;

      const property = await propertyForSetup(req, res, ctx);
      if (!property) return;

      const body = insertPropertyBudgetSchema.omit({ propertyId: true }).parse(req.body);

      const budget = await storage.upsertPropertyBudget({
        ...body,
        propertyId: property.id,
        region: property.region,
      });

      // An operating figure rather than deposit or rent data, but still an
      // amount somebody is expected to spend -- and this is an upsert, so the
      // previous figure is gone without a record of who changed it.
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.PROPERTY_BUDGET_SET,
        entityType: "property",
        entityId: property.id,
        summary: `Set the ${body.year} startup budget for ${property.name} to ${body.amount}`,
        details: { year: body.year, amount: body.amount, region: property.region },
      });

      res.json(budget);
    } catch (error) {
      sendError(res, error, "Failed to save the startup budget");
    }
  });

  // ── Repair & maintenance budgets ─────────────────────────────────────────

  // Staff only, under the property permission: the budget is an operating
  // figure about a house, read beside the house. A resident never reaches it,
  // whatever their grants -- unlike the startup budget, it is not the
  // household's to see.
  app.get('/api/repair-budgets', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewProperties", "canManageProperties")) return;

      res.json(filterByRegion(ctx, await storage.getAllRepairBudgets()));
    } catch (error) {
      sendError(res, error, "Failed to fetch repair budgets");
    }
  });

  // Admins only. Region-scoped as well, which an admin passes on the bypass;
  // it is there so that opening this to a permission later cannot forget it.
  app.put('/api/properties/:propertyId/repair-budget', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const property = await propertyForSetup(req, res, ctx);
      if (!property) return;
      if (property.ownership !== "owned") {
        return res.status(400).json({ message: "Repair budgets are set only for houses SPO owns" });
      }

      const body = insertRepairBudgetSchema.omit({ propertyId: true }).parse(req.body);
      const previous = await storage.getRepairBudget(property.id, body.fiscalYear);

      const budget = await storage.upsertRepairBudget({
        ...body,
        propertyId: property.id,
        region: property.region,
      });

      // Money: an upsert leaves no other trace of the figure it replaced.
      const label = fiscalYearLabel(body.fiscalYear);
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.PROPERTY_REPAIR_BUDGET_SET,
        entityType: "property",
        entityId: property.id,
        summary: previous
          ? `Changed the ${label} repair budget for ${property.name} from ${previous.amount} to ${budget.amount}`
          : `Set the ${label} repair budget for ${property.name} to ${budget.amount}`,
        details: {
          fiscalYear: body.fiscalYear,
          amount: budget.amount,
          previousAmount: previous?.amount ?? null,
          region: property.region,
        },
      });

      res.json(budget);
    } catch (error) {
      sendError(res, error, "Failed to save the repair budget");
    }
  });

  // ── QuickBooks (read-only repair & maintenance spend) ────────────────────
  //
  // Everything that manages the connection is admins only. The spend itself
  // is read by staff under the property permission, like the budget beside it.

  /** A QuickBooks failure, in the words the API module already wrote for an admin. */
  function quickBooksError(error: unknown): unknown {
    return error instanceof QuickBooksRequestError || error instanceof QuickBooksConnectionLostError
      ? new HttpError(502, error.message)
      : error;
  }

  app.get('/api/quickbooks/status', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      const [health, row] = await Promise.all([quickBooksHealth(), storage.getQuickbooksIntegration()]);
      // Never the token, encrypted or not: only what an admin needs to read.
      res.json({
        ...health,
        companyName: row?.companyName ?? null,
        connectedByEmail: row?.connectedByEmail ?? null,
        repairAccountIds: row?.repairAccountIds ?? [],
        lastAttemptAt: row?.lastAttemptAt ?? null,
        lastErrorAt: row?.lastErrorAt ?? null,
      });
    } catch (error) {
      sendError(res, error, "Failed to load the QuickBooks status");
    }
  });

  app.post('/api/quickbooks/connect', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      const config = readQuickBooksConfigFromEnv();
      if (!config.configured) {
        return res.status(409).json({ message: "QuickBooks is not set up on this server yet." });
      }
      // Ties the callback to this admin's own session, so a link someone else
      // started cannot attach a company to this portal.
      const state = randomBytes(24).toString("hex");
      req.session.quickbooksOAuthState = state;
      res.json({ url: createQuickBooksApi(config.config).authorizeUrl(state) });
    } catch (error) {
      sendError(res, error, "Failed to start connecting QuickBooks");
    }
  });

  // Intuit sends the browser back here. A page redirect, not JSON: the outcome
  // lands on Settings as ?quickbooks=connected|failed.
  app.get('/api/quickbooks/callback', isAuthenticated, async (req: any, res) => {
    const done = (outcome: "connected" | "failed" | "cancelled") => res.redirect(`/settings?quickbooks=${outcome}#quickbooks`);
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;

      const expected: unknown = req.session.quickbooksOAuthState;
      delete req.session.quickbooksOAuthState;
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const stateMatches =
        typeof expected === "string" &&
        expected.length === state.length &&
        timingSafeEqual(Buffer.from(expected), Buffer.from(state));
      if (!stateMatches) {
        logError("QuickBooks callback refused: state did not match this session", new Error("state mismatch"));
        return done("failed");
      }

      if (typeof req.query.error === "string") return done("cancelled");
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const realmId = typeof req.query.realmId === "string" && /^\d+$/.test(req.query.realmId) ? req.query.realmId : "";
      const config = readQuickBooksConfigFromEnv();
      if (!code || !realmId || !config.configured) return done("failed");

      const api = createQuickBooksApi(config.config);
      const tokens = await api.exchangeCode(code);
      const companyName = await api.companyName(tokens.accessToken, realmId);

      // A different company's class and account ids mean nothing here.
      const previous = await storage.getQuickbooksIntegration();
      const companyChanged = !!previous?.realmId && previous.realmId !== realmId;
      if (companyChanged) {
        for (const link of await storage.getAllPropertyQuickbooksLinks()) {
          await storage.deletePropertyQuickbooksLink(link.propertyId);
        }
      }

      await storage.updateQuickbooksIntegration({
        realmId,
        companyName,
        encryptedRefreshToken: encryptToken(tokens.refreshToken, config.config.tokenKey),
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
        connectedAt: new Date(),
        connectedByEmail: ctx.user.email ?? null,
        lastError: null,
        lastErrorAt: null,
        ...(companyChanged ? { repairAccountIds: [] } : {}),
      });

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.QUICKBOOKS_CONNECTED,
        entityType: "quickbooks",
        summary:
          `Connected QuickBooks company ${companyName}` +
          (companyChanged ? " (a different company: house links and account choices were cleared)" : ""),
        details: { companyName, companyChanged },
      });
      done("connected");
    } catch (error) {
      logError("QuickBooks connect failed", error);
      if (!res.headersSent) done("failed");
    }
  });

  app.post('/api/quickbooks/disconnect', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      const row = await storage.getQuickbooksIntegration();
      const config = readQuickBooksConfigFromEnv();

      // Best effort: tell Intuit to forget the token. Forgetting it here is
      // what matters, and happens whether or not Intuit answers.
      if (row?.encryptedRefreshToken && config.configured) {
        try {
          await createQuickBooksApi(config.config).revoke(decryptToken(row.encryptedRefreshToken, config.config.tokenKey));
        } catch (error) {
          logError("QuickBooks revoke failed; the token is forgotten here regardless", error);
        }
      }
      // The company id stays, so connecting a DIFFERENT company later is
      // recognised and the old company's links are cleared.
      await storage.updateQuickbooksIntegration({
        encryptedRefreshToken: null,
        refreshTokenExpiresAt: null,
        connectedAt: null,
        connectedByEmail: null,
      });
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.QUICKBOOKS_DISCONNECTED,
        entityType: "quickbooks",
        summary: `Disconnected QuickBooks${row?.companyName ? ` company ${row.companyName}` : ""}`,
      });
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error, "Failed to disconnect QuickBooks");
    }
  });

  app.get('/api/quickbooks/accounts', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      res.json(await withQuickBooks((api, token, realmId) => api.listExpenseAccounts(token, realmId)));
    } catch (error) {
      sendError(res, quickBooksError(error), "Failed to load the QuickBooks accounts");
    }
  });

  app.put('/api/quickbooks/accounts', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      const { accountIds } = z
        .object({ accountIds: z.array(z.string().regex(/^\d+$/, "Not a QuickBooks account id")).max(100) })
        .parse(req.body);
      const unique = Array.from(new Set(accountIds));
      const previous = (await storage.getQuickbooksIntegration())?.repairAccountIds ?? [];
      await storage.updateQuickbooksIntegration({ repairAccountIds: unique });
      // What counts as repair spend is a money decision.
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.QUICKBOOKS_ACCOUNTS_CHANGED,
        entityType: "quickbooks",
        summary: `Chose ${unique.length} QuickBooks account${unique.length === 1 ? "" : "s"} as repair & maintenance (was ${previous.length})`,
        details: { accountIds: unique, previousAccountIds: previous },
      });
      res.json({ repairAccountIds: unique });
    } catch (error) {
      sendError(res, error, "Failed to save the QuickBooks accounts");
    }
  });

  app.get('/api/quickbooks/classes', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      res.json(await withQuickBooks((api, token, realmId) => api.listClasses(token, realmId)));
    } catch (error) {
      sendError(res, quickBooksError(error), "Failed to load the QuickBooks classes");
    }
  });

  app.get('/api/quickbooks/links', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      res.json(await storage.getAllPropertyQuickbooksLinks());
    } catch (error) {
      sendError(res, error, "Failed to load the QuickBooks links");
    }
  });

  app.put('/api/properties/:propertyId/quickbooks-link', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      const property = await propertyForSetup(req, res, ctx);
      if (!property) return;
      if (property.ownership !== "owned") {
        return res.status(400).json({ message: "Only houses SPO owns are linked to QuickBooks" });
      }
      const { classId } = z.object({ classId: z.string().regex(/^\d+$/, "Not a QuickBooks class id") }).parse(req.body);

      // The name is QuickBooks's, never the caller's: a link to a class that
      // does not exist would read as a house that spent nothing.
      const classes = await withQuickBooks((api, token, realmId) => api.listClasses(token, realmId)).catch((error) => {
        throw quickBooksError(error);
      });
      const chosen = classes.find((c) => c.id === classId);
      if (!chosen) return res.status(400).json({ message: "That class is not in QuickBooks. Refresh the list and pick again." });

      const link = await storage.setPropertyQuickbooksLink({
        propertyId: property.id,
        kind: "class",
        externalId: chosen.id,
        externalName: chosen.name,
        region: property.region,
      });
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.QUICKBOOKS_MAPPING_CHANGED,
        entityType: "property",
        entityId: property.id,
        summary: `Linked ${property.name} to QuickBooks class ${chosen.name}`,
        details: { classId: chosen.id, className: chosen.name, region: property.region },
      });
      res.json(link);
    } catch (error) {
      sendError(res, error, "Failed to link the house to QuickBooks");
    }
  });

  app.delete('/api/properties/:propertyId/quickbooks-link', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      const property = await propertyForSetup(req, res, ctx);
      if (!property) return;
      const removed = await storage.deletePropertyQuickbooksLink(property.id);
      if (removed) {
        recordAuditEvent(ctx, {
          action: AUDIT_ACTIONS.QUICKBOOKS_MAPPING_CHANGED,
          entityType: "property",
          entityId: property.id,
          summary: `Unlinked ${property.name} from QuickBooks`,
          details: { region: property.region },
        });
      }
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error, "Failed to unlink the house from QuickBooks");
    }
  });

  app.post('/api/quickbooks/sync', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      res.json(await runQuickBooksSync(ctx));
    } catch (error) {
      sendError(res, error, "Failed to sync QuickBooks");
    }
  });

  // The spend, for the budget card and the dashboards. Says whether it is
  // connected and current, and which houses are linked, so a screen never
  // shows a missing figure as $0.
  app.get('/api/property-spend', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewProperties", "canManageProperties")) return;
      const [health, spend, links] = await Promise.all([
        quickBooksHealth(),
        storage.getAllPropertySpend(),
        storage.getAllPropertyQuickbooksLinks(),
      ]);
      res.json({
        connected: health.configured && health.connected,
        lastSuccessAt: health.lastSuccessAt,
        stale: isQuickBooksStale(health.lastSuccessAt, new Date()),
        linkedPropertyIds: filterByRegion(ctx, links).map((link) => link.propertyId),
        spend: filterByRegion(ctx, spend),
      });
    } catch (error) {
      sendError(res, error, "Failed to fetch repair spend");
    }
  });

  // ── Resident roster sync (master Google Sheet, or a CSV of the same columns)
  //
  // Admins only, every route: the sync writes across every region's roster.

  app.get('/api/roster-sync/status', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      const [health, runs, open, reviewed] = await Promise.all([
        rosterSyncHealth(),
        storage.getRecentRosterSyncRuns(10),
        storage.getRosterReviewItems("open", 200),
        storage.getRosterReviewItems("reviewed", 20),
      ]);
      const config = readRosterSheetConfigFromEnv();
      res.json({
        ...health,
        // Which sheet, so an admin can tell it is the right one; never the key.
        sheet: config.configured ? { tab: config.config.tab, serviceAccountEmail: config.config.clientEmail } : null,
        columns: Object.values(ROSTER_SHEET_COLUMNS),
        runs,
        openReviews: open,
        recentlyReviewed: reviewed,
      });
    } catch (error) {
      sendError(res, error, "Failed to load the roster sync status");
    }
  });

  app.post('/api/roster-sync/run', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      const { dryRun } = z.object({ dryRun: z.boolean() }).parse(req.body ?? {});
      if (!readRosterSheetConfigFromEnv().configured) {
        return res.status(409).json({ message: "The resident sheet is not set up on this server yet." });
      }
      res.json(dryRun ? await runRosterSync({ source: "sheet", dryRun: true, actor: ctx }) : await runScheduledRosterSync(ctx));
    } catch (error) {
      sendError(res, error, "Failed to run the roster sync");
    }
  });

  // The CSV fallback: the same columns, the same rules, the same banking
  // refusal. Checked BEFORE the body is read.
  const requireAdminBeforeUpload: RequestHandler = async (req: any, res, next) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      req.rosterCtx = ctx;
      next();
    } catch (error) {
      sendError(res, error, "Failed to start the roster import");
    }
  };

  app.post(
    '/api/roster-sync/csv',
    isAuthenticated,
    uploadRateLimit,
    requireAdminBeforeUpload,
    ...guardedUpload(csvUpload.single('file'), CSV_IMPORT_MAX_BYTES),
    async (req: any, res) => {
      try {
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });
        const text = decodeCsv(req.file.buffer);
        if (text === null) {
          return res.status(400).json({ message: "That file is not readable as text. Export it as CSV and try again." });
        }
        const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), { skipEmptyLines: "greedy" });
        const [headers = [], ...rows] = parsed.data;
        const dryRun = req.query.dryRun !== "false";
        res.json(await runRosterSync({ source: "csv", table: { headers, rows }, dryRun, actor: req.rosterCtx }));
      } catch (error) {
        sendError(res, error, "Failed to read the roster file");
      }
    },
  );

  app.post('/api/roster-review-items/:id/reviewed', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      const item = await storage.markRosterReviewItemReviewed(req.params.id, ctx.user.email ?? null);
      if (!item) return res.status(404).json({ message: "That review item is already reviewed or does not exist" });
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.RESIDENT_REVIEW_RESOLVED,
        entityType: "roster_review_item",
        entityId: item.id,
        summary: `Marked reviewed: ${item.detail}`,
        details: { kind: item.kind, residentId: item.residentId },
      });
      res.json(item);
    } catch (error) {
      sendError(res, error, "Failed to mark the item reviewed");
    }
  });

  // ── Email health ─────────────────────────────────────────────────────────
  //
  // Admins only. The log holds which email, to whom and whether it went --
  // never what it said.

  app.get('/api/email-health', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
      res.json(summarizeEmailLog(await storage.getEmailLogSince(since), readEmailConfigFromEnv().configured));
    } catch (error) {
      sendError(res, error, "Failed to load email health");
    }
  });

  // Sends one test message to the admin pressing the button, and nobody else.
  app.post('/api/email-health/test', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      const to = ctx.user.email;
      if (!to) return res.status(400).json({ message: "Your account has no email address to send to" });
      const result = await sendEmail({
        template: "test",
        to,
        subject: "Test email from the SPO portal",
        text: "This is a test from Settings → Email health. If you are reading it, the portal's email is working.\n\nSaint Paul's Outreach housing",
      });
      res.json(result);
    } catch (error) {
      sendError(res, error, "Failed to send the test email");
    }
  });

  // ── Household portal access (invite-only, #217) ──────────────────────────
  //
  // Nobody signs up: a household leader or steward gets in because their RA
  // gave them access from the house's roster. Staff under the property
  // permission, in the resident's region; at most HOUSE_PORTAL_ACCOUNT_LIMIT
  // per house. The account waits for the person's first Google sign-in with
  // the roster email (server/auth.ts recordSignIn).

  /** The login a roster row would speak for: a resident account with its email, case aside. */
  async function portalAccountFor(resident: { email: string }) {
    const account = await storage.getUserByEmailInsensitive(resident.email);
    return account && account.role === "resident" ? account : undefined;
  }

  app.get('/api/residents/:id/portal-access', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      const resident = await residentForMoveOut(req, res, ctx, "view");
      if (!resident) return;
      const [account, house] = await Promise.all([
        portalAccountFor(resident),
        storage.getActiveResidentAccountsByProperty(resident.propertyId),
      ]);
      const hasAccess = !!account && account.isActive && account.propertyId === resident.propertyId;
      res.json({
        hasAccess,
        // Never an id or anything about the account beyond what the screen says.
        houseAccounts: house.map((u) => ({ name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email, email: u.email })),
        limit: HOUSE_PORTAL_ACCOUNT_LIMIT,
      });
    } catch (error) {
      sendError(res, error, "Failed to load portal access");
    }
  });

  app.post('/api/residents/:id/portal-access', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      const resident = await residentForMoveOut(req, res, ctx, "manage");
      if (!resident) return;

      const today = new Date().toISOString().slice(0, 10);
      const stopped = resident.moveOutDate && new Date(resident.moveOutDate).toISOString().slice(0, 10) < today;
      if (!resident.isActive || stopped) {
        return res.status(400).json({ message: "Only someone living in the house now can be given access" });
      }
      const email = resident.email.trim().toLowerCase();
      const existing = await storage.getUserByEmailInsensitive(email);
      if (existing && existing.role !== "resident") {
        return res.status(409).json({ message: "That email belongs to a staff account. Use a different email for the household login." });
      }
      // A login another house gave access to is not this roster row's to take, whatever region
      // that house is in (the mirror of the DELETE below). Its house is not named: it may be
      // outside the caller's regions.
      if (existing?.propertyId && existing.propertyId !== resident.propertyId) {
        return res.status(409).json({
          message: "That email already has a household login for another house. It has to be removed there first: ask that house's regional administrator, or an admin.",
        });
      }

      const house = (await storage.getActiveResidentAccountsByProperty(resident.propertyId)).filter((u) => u.id !== existing?.id);
      if (house.length >= HOUSE_PORTAL_ACCOUNT_LIMIT) {
        return res.status(409).json({
          message: `${resident.buildingAddress} already has ${HOUSE_PORTAL_ACCOUNT_LIMIT} people with access (${house
            .map((u) => u.email)
            .join(", ")}). Remove one first.`,
        });
      }

      const { user, created, previous } = await storage.grantResidentPortalAccess({
        email,
        firstName: resident.firstName,
        lastName: resident.lastName,
        propertyId: resident.propertyId,
      });
      // Access history, kept indefinitely (AUDIT_ACTIONS_KEPT_INDEFINITELY).
      if (created) {
        recordAuditEvent(ctx, {
          action: AUDIT_ACTIONS.USER_CREATED,
          entityType: "user",
          entityId: user.id,
          summary: `Gave ${email} portal access to ${resident.buildingAddress} (waiting for their first sign-in)`,
          details: { role: "resident", propertyId: resident.propertyId, residentId: resident.id },
        });
      } else {
        if (!previous?.isActive) {
          recordAuditEvent(ctx, {
            action: AUDIT_ACTIONS.USER_STATUS_CHANGED,
            entityType: "user",
            entityId: user.id,
            summary: `Reactivated ${email} to give them portal access to ${resident.buildingAddress}`,
            details: { isActive: true, residentId: resident.id },
          });
        }
        if (previous?.propertyId !== resident.propertyId) {
          recordAuditEvent(ctx, {
            action: AUDIT_ACTIONS.USER_PROPERTY_CHANGED,
            entityType: "user",
            entityId: user.id,
            summary: `Linked ${email} to ${resident.buildingAddress} to give them portal access`,
            details: { from: previous?.propertyId ?? null, to: resident.propertyId, residentId: resident.id },
          });
        }
      }
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.USER_PERMISSIONS_CHANGED,
        entityType: "user",
        entityId: user.id,
        summary: `Set ${email}'s household permissions: maintenance, walkthroughs, resources`,
        details: { canViewMaintenance: true, canCompleteWalkthroughs: true, canViewResourceHub: true },
      });
      res.json({ hasAccess: true });
    } catch (error) {
      sendError(res, error, "Failed to give portal access");
    }
  });

  app.delete('/api/residents/:id/portal-access', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      const resident = await residentForMoveOut(req, res, ctx, "manage");
      if (!resident) return;
      const account = await portalAccountFor(resident);
      // Only the login this house gave access to; one linked elsewhere is not this roster row's to switch off.
      if (!account || !account.isActive || account.propertyId !== resident.propertyId) {
        return res.json({ hasAccess: false });
      }
      await storage.deactivateAndUnlinkUser(account.id);
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.USER_STATUS_CHANGED,
        entityType: "user",
        entityId: account.id,
        summary: `Removed ${account.email}'s portal access to ${resident.buildingAddress}`,
        details: { isActive: false, reason: "access_removed", residentId: resident.id },
      });
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.USER_PROPERTY_CHANGED,
        entityType: "user",
        entityId: account.id,
        summary: `Unlinked ${account.email} from ${resident.buildingAddress}`,
        details: { from: account.propertyId, to: null, reason: "access_removed", residentId: resident.id },
      });
      res.json({ hasAccess: false });
    } catch (error) {
      sendError(res, error, "Failed to remove portal access");
    }
  });

  // ── Move-out checklist ───────────────────────────────────────────────────
  //
  // The RA's record that a room was checked when somebody left. Staff only,
  // under the property permission (the roster's own), in the resident's region.

  async function residentForMoveOut(req: any, res: any, ctx: AuthContext, need: "view" | "manage") {
    if (!requireStaff(res, ctx)) return undefined;
    const flags = need === "manage" ? (["canManageProperties"] as const) : (["canViewProperties", "canManageProperties"] as const);
    if (!requirePermission(res, ctx, ...flags)) return undefined;
    const resident = await storage.getResident(req.params.id);
    if (!resident) {
      res.status(404).json({ message: "Resident not found" });
      return undefined;
    }
    if (!requireRegion(res, ctx, resident.region)) return undefined;
    return resident;
  }

  app.get('/api/residents/:id/move-out-checklist', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      const resident = await residentForMoveOut(req, res, ctx, "view");
      if (!resident) return;
      const [checklist, photos] = await Promise.all([storage.getMoveOutChecklist(resident.id), storage.getMoveOutPhotos(resident.id)]);
      res.json({ checklist: checklist ?? null, photos });
    } catch (error) {
      sendError(res, error, "Failed to load the move-out checklist");
    }
  });

  app.put('/api/residents/:id/move-out-checklist', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      const resident = await residentForMoveOut(req, res, ctx, "manage");
      if (!resident) return;
      const { complete, ...fields } = insertMoveOutChecklistSchema.parse(req.body);
      if (complete && !(fields.roomInspected && fields.belongingsRemoved && fields.keysReturned)) {
        return res.status(400).json({ message: "Tick all three checks before marking the move-out complete" });
      }
      const existing = await storage.getMoveOutChecklist(resident.id);
      // Completing records who and when, once; editing a completed checklist
      // keeps that record unless it is reopened by un-ticking a check.
      const stillComplete = complete || (!!existing?.completedAt && fields.roomInspected && fields.belongingsRemoved && fields.keysReturned);
      const checklist = await storage.upsertMoveOutChecklist({
        residentId: resident.id,
        region: resident.region,
        ...fields,
        completedAt: stillComplete ? (existing?.completedAt ?? new Date()) : null,
        completedByEmail: stillComplete ? (existing?.completedByEmail ?? ctx.user.email ?? null) : null,
      });
      if (complete && !existing?.completedAt) {
        recordAuditEvent(ctx, {
          action: AUDIT_ACTIONS.RESIDENT_MOVE_OUT_CHECKLIST_COMPLETED,
          entityType: "resident",
          entityId: resident.id,
          summary: `Completed the move-out checklist for ${resident.firstName} ${resident.lastName} at ${resident.buildingAddress}`,
          details: { region: resident.region, damageNoted: !!fields.damageNotes },
        });
      }
      res.json(checklist);
    } catch (error) {
      sendError(res, error, "Failed to save the move-out checklist");
    }
  });

  app.post('/api/residents/:id/move-out-photos', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      const resident = await residentForMoveOut(req, res, ctx, "manage");
      if (!resident) return;
      const { imageUrl } = z.object({ imageUrl: z.string() }).parse(req.body);
      // Only a file this caller stored, in the /uploads/<key> shape.
      await requireOwnUploads(ctx, { imageUrl }, ["imageUrl"]);
      res.json(
        await storage.createMoveOutPhoto({ residentId: resident.id, imageUrl, region: resident.region, uploadedByEmail: ctx.user.email ?? null }),
      );
    } catch (error) {
      sendError(res, error, "Failed to add the photo");
    }
  });

  app.delete('/api/move-out-photos/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageProperties")) return;
      const photo = await storage.getMoveOutPhoto(req.params.id);
      if (!photo) return res.status(404).json({ message: "Photo not found" });
      if (!requireRegion(res, ctx, photo.region)) return;
      await removeDeletedRecordFiles(await storage.deleteMoveOutPhoto(photo.id));
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to remove the photo");
    }
  });

  // ── Deposit return deadlines per state ───────────────────────────────────
  //
  // Admin-entered, empty until SPO confirms each state's rule. Never a figure
  // the portal ships with (.claude/rules/deposits.md).

  app.get('/api/deposit-return-rules', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      res.json(await storage.getAllDepositReturnRules());
    } catch (error) {
      sendError(res, error, "Failed to load the deposit deadlines");
    }
  });

  app.put('/api/deposit-return-rules/:state', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireAdmin(res, ctx)) return;
      const state = String(req.params.state).toUpperCase();
      if (!/^[A-Z]{2}$/.test(state)) return res.status(400).json({ message: "Use a two-letter state code" });
      const { days } = z
        .object({ days: z.number().int("Whole days only").min(1, "At least 1 day").max(365, "At most 365 days").nullable() })
        .parse(req.body);
      const previous = (await storage.getAllDepositReturnRules()).find((r) => r.state === state);
      await storage.setDepositReturnRule(state, days, ctx.user.email ?? null);
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.DEPOSIT_RULE_CHANGED,
        entityType: "deposit_rule",
        entityId: state,
        summary:
          days === null
            ? `Cleared the ${state} deposit return deadline (was ${previous?.days ?? "unset"} days)`
            : `Set the ${state} deposit return deadline to ${days} days (was ${previous?.days ?? "unset"})`,
        details: { state, days, previousDays: previous?.days ?? null },
      });
      res.json({ state, days });
    } catch (error) {
      sendError(res, error, "Failed to save the deposit deadline");
    }
  });

  // ── Aggregates: what keeps going wrong, and who keeps being called back ───

  /**
   * Rollups over the maintenance history the caller can already see.
   *
   * The Phase 5 filters answer "what happened here?"; these answer "what keeps
   * happening here?", which is the question that settles an argument about
   * whether to keep renting a house or keep using a contractor.
   *
   * Both are computed over the caller's own visible requests, so a rollup can
   * never widen what somebody can see.
   */
  app.get('/api/maintenance-aggregates', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewMaintenance", "canManageMaintenance")) return;

      const requests = filterByRegion(ctx, await storage.getAllMaintenanceRequests());
      const links = await storage.getAllRequestContactLinks();

      res.json({
        recurringIssues: recurringIssues(requests),
        contractorLoad: contractorLoad(links, requests),
      });
    } catch (error) {
      sendError(res, error, "Failed to build the rollups");
    }
  });

  // Action items + Tasks Routes
  //
  // "Action items" are the dashboard's derived list -- unpaid rent, deposits to
  // return, maintenance coming due -- plus the open manual tasks the caller can
  // see. Nothing here creates finance data; resolving a derived item happens on
  // its own (already-audited) endpoint. The surface is staff only, and every
  // item follows the flag of the list it comes from (`canSeeActionItemSource`),
  // so this is never a way round a list route's 403 (#158). Finance records
  // are not even read without the finance flags.
  app.get('/api/action-items', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      const seesFinance = canSeeActionItemSource(ctx, "rent");

      const [schedules, rentPayments, deposits, deductions, residents, allTasks, properties, setupItems, assets, requests] = await Promise.all([
        storage.getAllMaintenanceSchedules(),
        seesFinance ? storage.getAllRentPayments() : [],
        seesFinance ? storage.getAllSecurityDeposits() : [],
        seesFinance ? storage.getAllDepositDeductions() : [],
        storage.getAllResidents(),
        storage.getAllTasks(),
        storage.getAllProperties(),
        storage.getAllPropertySetupItems(),
        storage.getAllAssets(),
        storage.getAllMaintenanceRequests(),
      ]);

      // Each read only for someone who may see what it feeds: admins for the
      // connection, the property flag for budgets. Nobody else's list costs
      // the lookup.
      const seesBudgets = canSeeActionItemSource(ctx, "budget");
      const seesIntegrations = canSeeActionItemSource(ctx, "integration");
      const needsHealth = seesBudgets || seesIntegrations;
      const [health, roster, email, repairBudgets, spend, links] = await Promise.all([
        needsHealth ? quickBooksHealth() : undefined,
        seesIntegrations ? rosterSyncHealth() : undefined,
        seesIntegrations ? emailHealth() : undefined,
        seesBudgets ? storage.getAllRepairBudgets() : [],
        seesBudgets ? storage.getAllPropertySpend() : [],
        seesBudgets ? storage.getAllPropertyQuickbooksLinks() : [],
      ]);

      const depositRules = seesFinance ? await storage.getAllDepositReturnRules() : [];

      const items = buildActionItems({
        depositRules,
        quickbooks: seesIntegrations ? health : undefined,
        roster,
        email,
        repairBudgets:
          seesBudgets && health
            ? {
                budgets: filterByRegion(ctx, repairBudgets),
                spend: filterByRegion(ctx, spend),
                linkedPropertyIds: filterByRegion(ctx, links).map((link) => link.propertyId),
                spendCurrent: health.configured && health.connected && !isQuickBooksStale(health.lastSuccessAt, new Date()),
              }
            : undefined,
        // Derived items are region-scoped exactly like their source lists.
        schedules: filterByRegion(ctx, schedules),
        rentPayments: filterByRegion(ctx, rentPayments),
        deposits: filterByRegion(ctx, deposits),
        deductions: filterByRegion(ctx, deductions),
        // Residents are only used to tell which deposits belong to someone who
        // moved out; they need not be filtered (the deposits already are).
        residents,
        tasks: allTasks.filter((t) => canSeeTask(ctx, t)),
        properties: filterByRegion(ctx, properties),
        // Not filtered: the checklist rows are only ever read against the
        // already-filtered property list above, so a row whose house is out of
        // region has nothing to attach to.
        setupItems,
        assets: filterByRegion(ctx, assets),
        // Staff only (requireStaff above), so the region rule is the whole
        // rule -- and it fails closed on an empty region list.
        requests: filterByRegion(ctx, requests),
      });
      res.json(items.filter((item) => canSeeActionItemSource(ctx, item.source)));
    } catch (error) {
      sendError(res, error, "Failed to load action items");
    }
  });

  // Per-region rollup for the leadership dashboard. An admin sees every region;
  // a regional admin sees only the region(s) they are assigned. Staff only, and
  // each count follows the same flag as the action items it summarises (#158):
  // a record the caller could not list is not read, so it counts as nothing.
  app.get('/api/region-summary', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      const visibility = {
        maintenance: canSeeActionItemSource(ctx, "maintenance"),
        schedule: canSeeActionItemSource(ctx, "schedule"),
        lease: canSeeActionItemSource(ctx, "lease"),
        rent: canSeeActionItemSource(ctx, "rent"),
      };
      const [requests, schedules, properties, rentPayments, tasks, users, permissions] = await Promise.all([
        visibility.maintenance ? storage.getAllMaintenanceRequests() : [],
        visibility.schedule ? storage.getAllMaintenanceSchedules() : [],
        visibility.lease ? storage.getAllProperties() : [],
        visibility.rent ? storage.getAllRentPayments() : [],
        storage.getAllTasks(),
        storage.getAllUsers(),
        storage.getAllUserPermissions(),
      ]);

      // Which regions the caller may see: every region for an admin, otherwise
      // just their own assigned regions.
      const regions = ctx.isAdmin ? [...REGIONS] : normalizeRegions(ctx.allowedRegions);

      // Regional admins and their assigned regions, for naming each region's lead.
      const regionsByUser = new Map(permissions.map((p) => [p.userId, normalizeRegions(p.allowedRegions ?? [])]));
      const staff: RegionStaff[] = users
        .filter((u) => u.role === "regional_administrator" && u.isActive)
        .map((u) => ({
          name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || (u.email ?? "Unnamed"),
          email: u.email ?? null,
          regions: regionsByUser.get(u.id) ?? [],
        }));

      const summaries = buildRegionSummaries(
        {
          requests: filterByRegion(ctx, requests),
          schedules: filterByRegion(ctx, schedules),
          properties: filterByRegion(ctx, properties),
          rentPayments: filterByRegion(ctx, rentPayments),
          // Not `filterByRegion`: a lease-derived task needs the properties
          // flag on top of region, exactly like `/api/tasks` (#170).
          tasks: tasks.filter((t) => canSeeTask(ctx, t)),
          staff,
          visibility,
        },
        regions,
      );
      res.json(summaries);
    } catch (error) {
      sendError(res, error, "Failed to load region summary");
    }
  });

  app.get('/api/tasks', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;

      const allTasks = await storage.getAllTasks();
      res.json(allTasks.filter((t) => canSeeTask(ctx, t)));
    } catch (error) {
      sendError(res, error, "Failed to fetch tasks");
    }
  });

  app.post('/api/tasks', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;

      const validatedData = insertTaskSchema.parse(req.body);

      // Scope rules. A personal task ("just me") belongs to the creator and has
      // no region -- forced, because a personal task outlives its owner's
      // account only as a region-free, ownerless row, which `canSeeTask` keeps
      // to admins. A region broadcast must be a region the creator can reach.
      // An all-regions broadcast (no region) is an admin-only announcement.
      const assignedToUserId = validatedData.assignedToUserId ? ctx.userId : null;
      if (!assignedToUserId) {
        if (validatedData.region == null) {
          if (!requireAdmin(res, ctx)) return;
        } else if (!requireRegion(res, ctx, validatedData.region, "Forbidden - Cannot create in this region")) {
          return;
        }
      }

      const task = await storage.createTask({
        ...validatedData,
        region: assignedToUserId ? null : validatedData.region,
        assignedToUserId,
        createdBy: ctx.userId,
      });
      res.json(task);
    } catch (error) {
      sendError(res, error, "Failed to create task");
    }
  });

  app.patch('/api/tasks/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;

      const existing = await storage.getTask(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Task not found" });
      }
      if (!canSeeTask(ctx, existing)) {
        return res.status(403).json({ message: "Forbidden - Task not accessible" });
      }

      // Who a task is for is fixed once created; only its content and status are
      // editable here.
      const { region: _re, assignedToUserId: _a, createdBy: _c, completedBy: _cb, completedAt: _ca, ...editable } = req.body ?? {};
      const validatedData = insertTaskSchema.partial().parse(editable);

      // Completing a task stamps who finished it and when; reopening clears both.
      const lifecycle =
        validatedData.status === "done"
          ? { completedBy: ctx.userId, completedAt: new Date() }
          : validatedData.status === "open"
            ? { completedBy: null, completedAt: null }
            : {};

      const task = await storage.updateTask(req.params.id, { ...validatedData, ...lifecycle });
      res.json(task);
    } catch (error) {
      sendError(res, error, "Failed to update task");
    }
  });

  app.delete('/api/tasks/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;

      const existing = await storage.getTask(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: "Task not found" });
      }
      // Only the person who created a task (or an admin) may delete it.
      if (!ctx.isAdmin && existing.createdBy !== ctx.userId) {
        return res.status(403).json({ message: "Forbidden - Only the creator can delete this task" });
      }

      await storage.deleteTask(req.params.id);
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete task");
    }
  });

  // Maintenance Contacts Routes
  app.get('/api/contacts', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewContacts", "canManageContacts")) return;

      const contacts = await storage.getAllMaintenanceContacts();
      res.json(filterByRegion(ctx, contacts));
    } catch (error) {
      sendError(res, error, "Failed to fetch contacts");
    }
  });

  app.post('/api/contacts', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageContacts")) return;

      const validatedData = insertMaintenanceContactSchema.parse(req.body);

      if (!requireRegion(res, ctx, validatedData.region, "Forbidden - Cannot create in this region")) return;

      const contact = await storage.createMaintenanceContact(validatedData);
      res.json(contact);
    } catch (error) {
      sendError(res, error, "Failed to create contact");
    }
  });

  app.patch('/api/contacts/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageContacts")) return;

      const existingContact = await storage.getMaintenanceContact(req.params.id);
      if (!existingContact) {
        return res.status(404).json({ message: "Contact not found" });
      }

      const validatedData = insertMaintenanceContactSchema.partial().parse(req.body);

      if (!requireRegionMove(res, ctx, existingContact.region, validatedData.region)) return;

      const contact = await storage.updateMaintenanceContact(req.params.id, validatedData);
      res.json(contact);
    } catch (error) {
      sendError(res, error, "Failed to update contact");
    }
  });

  app.delete('/api/contacts/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageContacts")) return;

      const existingContact = await storage.getMaintenanceContact(req.params.id);
      if (!existingContact) {
        return res.status(404).json({ message: "Contact not found" });
      }

      if (!requireRegion(res, ctx, existingContact.region)) return;

      await storage.deleteMaintenanceContact(req.params.id);
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete contact");
    }
  });

  // Invoices Routes
  // ---------------------------------------------------------------------------
  // Contractor history
  //
  // Mostly a read over data that already exists: request_contacts has linked
  // vendors to requests all along, and invoices already carry a contactId --
  // there was simply nowhere to read it. The concern this answers is real
  // though: what an RA learned working with a vendor currently dies at
  // handover.
  //
  // There is deliberately NO RATING. A star score on a vendor SPO may have to
  // keep using invites arguments about the number, and tells an incoming RA
  // far less than a paragraph does.
  // ---------------------------------------------------------------------------

  /** The contact, once, with the checks every contractor-history route makes. */
  async function contactForHistory(req: any, res: any, ctx: AuthContext) {
    const contact = await storage.getMaintenanceContact(req.params.id);
    if (!contact) {
      res.status(404).json({ message: "Contact not found" });
      return undefined;
    }
    if (!requireRegion(res, ctx, contact.region)) return undefined;
    return contact;
  }

  app.get('/api/contacts/:id/requests', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewContacts", "canManageContacts")) return;

      const contact = await contactForHistory(req, res, ctx);
      if (!contact) return;

      // Filtered again by the REQUEST's own region, not the contact's: a
      // vendor can work across regions, and reading their page must not become
      // a way to see requests the caller could not otherwise open.
      res.json(filterByRegion(ctx, await storage.getRequestsForContact(contact.id)));
    } catch (error) {
      sendError(res, error, "Failed to fetch this contractor's requests");
    }
  });

  app.get('/api/contacts/:id/notes', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewContacts", "canManageContacts")) return;

      const contact = await contactForHistory(req, res, ctx);
      if (!contact) return;

      res.json(await storage.getContactNotes(contact.id));
    } catch (error) {
      sendError(res, error, "Failed to fetch notes on this contractor");
    }
  });

  app.post('/api/contacts/:id/notes', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageContacts")) return;

      const contact = await contactForHistory(req, res, ctx);
      if (!contact) return;

      // Only `body` survives the parse. Everything that says whose note this
      // is comes from the session, and the region from the contact -- a note
      // whose author the client chose would be worth nothing. Anything else
      // sent (a rating, say) is dropped rather than stored.
      const { body } = insertContactNoteSchema.parse(req.body);

      const note = await storage.createContactNote({
        body,
        contactId: contact.id,
        authorUserId: ctx.userId,
        authorEmail: ctx.user.email ?? null,
        region: contact.region,
      });

      res.json(note);
    } catch (error) {
      sendError(res, error, "Failed to save the note");
    }
  });

  app.delete('/api/contact-notes/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageContacts")) return;

      const note = await storage.getContactNote(req.params.id);
      if (!note) {
        return res.status(404).json({ message: "Note not found" });
      }
      if (!requireRegion(res, ctx, note.region)) return;

      await storage.deleteContactNote(req.params.id);
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete the note");
    }
  });

  app.get('/api/invoices', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewBilling", "canManageBilling")) return;

      const invoices = await storage.getAllInvoices();
      res.json(filterByRegion(ctx, invoices));
    } catch (error) {
      sendError(res, error, "Failed to fetch invoices");
    }
  });

  /**
   * An invoice points at a contact, a request and a house, and a billing
   * record at a contact; each must be one the caller can reach -- the rule
   * resolveContactLink applies when a contact is linked to a request.
   * Otherwise a record created in the caller's region could tie together
   * records from regions they cannot see. A value the record already holds is
   * not a new reference and passes, so an edit that resends it is not refused.
   * Sends the response and returns false on a refusal.
   */
  async function requireInvoiceReferences(
    res: Response,
    ctx: AuthContext,
    incoming: { contactId?: string | null; maintenanceRequestId?: string | null; buildingAddress?: string },
    existing?: { contactId: string | null; maintenanceRequestId?: string | null; buildingAddress?: string },
  ): Promise<boolean> {
    const isNew = <K extends keyof typeof incoming>(key: K) =>
      !!incoming[key] && (!existing || incoming[key] !== existing[key]);

    if (isNew("contactId")) {
      const contact = await storage.getMaintenanceContact(incoming.contactId!);
      if (!contact) {
        res.status(400).json({ message: "That contact is not on file." });
        return false;
      }
      if (!requireRegion(res, ctx, contact.region)) return false;
    }
    if (isNew("maintenanceRequestId")) {
      const request = await storage.getMaintenanceRequest(incoming.maintenanceRequestId!);
      if (!request) {
        res.status(400).json({ message: "That maintenance request does not exist." });
        return false;
      }
      if (!requireRegion(res, ctx, request.region)) return false;
    }
    if (isNew("buildingAddress")) {
      const house = await storage.getPropertyByAddress(incoming.buildingAddress!);
      if (!house) {
        res.status(400).json({ message: "Choose one of the portal's houses for this invoice." });
        return false;
      }
      if (!requireRegion(res, ctx, house.region)) return false;
    }
    return true;
  }

  app.post('/api/invoices', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageBilling")) return;

      const validatedData = insertInvoiceSchema.parse(req.body);

      if (!requireRegion(res, ctx, validatedData.region, "Forbidden - Cannot create in this region")) return;
      if (!(await requireInvoiceReferences(res, ctx, validatedData))) return;

      const invoice = await storage.createInvoice(validatedData);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.INVOICE_CREATED,
        entityType: "invoice",
        entityId: invoice.id,
        summary: `Created an invoice for ${invoice.amount ?? "an unstated amount"} in ${invoice.region}`,
        details: { amount: invoice.amount ?? null, status: invoice.status ?? null, region: invoice.region },
      });

      res.json(invoice);
    } catch (error) {
      sendError(res, error, "Failed to create invoice");
    }
  });

  app.patch('/api/invoices/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageBilling")) return;

      const existingInvoice = await storage.getInvoice(req.params.id);
      if (!existingInvoice) {
        return res.status(404).json({ message: "Invoice not found" });
      }

      const validatedData = insertInvoiceSchema.partial().parse(req.body);

      if (!requireRegionMove(res, ctx, existingInvoice.region, validatedData.region)) return;
      if (!(await requireInvoiceReferences(res, ctx, validatedData, existingInvoice))) return;

      const invoice = await storage.updateInvoice(req.params.id, validatedData);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.INVOICE_UPDATED,
        entityType: "invoice",
        entityId: req.params.id,
        summary: `Updated an invoice in ${existingInvoice.region}`,
        details: {
          changed: changedFields(existingInvoice as unknown as Record<string, unknown>, validatedData),
          amount: invoice.amount ?? null,
          status: invoice.status ?? null,
        },
      });

      res.json(invoice);
    } catch (error) {
      sendError(res, error, "Failed to update invoice");
    }
  });

  app.delete('/api/invoices/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageBilling")) return;

      const existingInvoice = await storage.getInvoice(req.params.id);
      if (!existingInvoice) {
        return res.status(404).json({ message: "Invoice not found" });
      }

      if (!requireRegion(res, ctx, existingInvoice.region)) return;

      await storage.deleteInvoice(req.params.id);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.INVOICE_DELETED,
        entityType: "invoice",
        entityId: req.params.id,
        summary: `Deleted an invoice for ${existingInvoice.amount ?? "an unstated amount"} in ${existingInvoice.region}`,
        details: { amount: existingInvoice.amount ?? null, status: existingInvoice.status ?? null },
      });

      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete invoice");
    }
  });

  // Billing Records Routes
  app.get('/api/billing', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewBilling", "canManageBilling")) return;

      const billingRecords = await storage.getAllBillingRecords();
      res.json(filterByRegion(ctx, billingRecords));
    } catch (error) {
      sendError(res, error, "Failed to fetch billing records");
    }
  });

  const BILLING_DOCUMENT_FIELDS = ["contractInvoiceUrl", "coiUrl", "w9Url"] as const;

  app.post('/api/billing', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageBilling")) return;

      const { createContact, ...rest } = req.body;
      const validatedData = insertBillingRecordSchema.parse(rest);

      if (!requireRegion(res, ctx, validatedData.region, "Forbidden - Cannot create in this region")) return;
      if (!(await requireInvoiceReferences(res, ctx, { contactId: validatedData.contactId }))) return;
      await requireOwnUploads(ctx, validatedData, BILLING_DOCUMENT_FIELDS);

      // If createContact is true and no contactId, create a new contact from the billing info
      if (createContact && !validatedData.contactId) {
        const newContact = await storage.createMaintenanceContact({
          name: validatedData.companyName,
          company: validatedData.companyName,
          service: "",
          phone: validatedData.phone,
          email: validatedData.email,
          // Inherit the billing record's region rather than creating the
          // contact with an empty one, which would have made it invisible to
          // every non-admin in the contacts list.
          region: validatedData.region,
          buildingAddress: "",
        });
        (validatedData as any).contactId = newContact.id;
      }

      const record = await storage.createBillingRecord(validatedData);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.BILLING_RECORD_CREATED,
        entityType: "billing_record",
        entityId: record.id,
        summary: `Created a billing record for ${record.companyName ?? "an unnamed company"} in ${record.region}`,
        details: { invoiceCost: record.invoiceCost ?? null, region: record.region },
      });

      res.json(record);
    } catch (error) {
      sendError(res, error, "Failed to create billing record");
    }
  });

  app.patch('/api/billing/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageBilling")) return;

      const existingRecord = await storage.getBillingRecord(req.params.id);
      if (!existingRecord) {
        return res.status(404).json({ message: "Billing record not found" });
      }

      const validatedData = insertBillingRecordSchema.partial().parse(req.body);

      if (!requireRegionMove(res, ctx, existingRecord.region, validatedData.region)) return;
      if (!(await requireInvoiceReferences(res, ctx, { contactId: validatedData.contactId }, existingRecord))) return;
      await requireOwnUploads(ctx, validatedData, BILLING_DOCUMENT_FIELDS, existingRecord);

      const record = await storage.updateBillingRecord(req.params.id, validatedData);
      await removeDeletedRecordFiles(replacedFileUrls(existingRecord, validatedData, BILLING_DOCUMENT_FIELDS));

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.BILLING_RECORD_UPDATED,
        entityType: "billing_record",
        entityId: req.params.id,
        summary: `Updated the billing record for ${existingRecord.companyName ?? "an unnamed company"}`,
        details: {
          changed: changedFields(existingRecord as unknown as Record<string, unknown>, validatedData),
          invoiceCost: record.invoiceCost ?? null,
        },
      });

      res.json(record);
    } catch (error) {
      sendError(res, error, "Failed to update billing record");
    }
  });

  app.delete('/api/billing/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageBilling")) return;

      const existingRecord = await storage.getBillingRecord(req.params.id);
      if (!existingRecord) {
        return res.status(404).json({ message: "Billing record not found" });
      }

      if (!requireRegion(res, ctx, existingRecord.region)) return;

      await removeDeletedRecordFiles(await storage.deleteBillingRecord(req.params.id));

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.BILLING_RECORD_DELETED,
        entityType: "billing_record",
        entityId: req.params.id,
        summary: `Deleted the billing record for ${existingRecord.companyName ?? "an unnamed company"}`,
        details: { invoiceCost: existingRecord.invoiceCost ?? null, region: existingRecord.region },
      });

      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete billing record");
    }
  });

  // Properties Routes
  app.get('/api/properties', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewProperties", "canManageProperties")) return;

      const properties = await storage.getAllProperties();
      res.json(filterByRegion(ctx, properties));
    } catch (error) {
      sendError(res, error, "Failed to fetch properties");
    }
  });

  app.post('/api/properties', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageProperties")) return;

      const validatedData = insertPropertySchema.parse(req.body);

      if (!requireRegion(res, ctx, validatedData.region, "Forbidden - Cannot create in this region")) return;
      await requireOwnUploads(ctx, validatedData, ["photoUrl"]);

      // Compute full address from components
      const address = `${validatedData.streetAddress}, ${validatedData.city}, ${validatedData.state} ${validatedData.zipCode}`;
      const property = await storage.createProperty({ ...validatedData, address });

      // Seed the setup checklist for the new house. Deliberately best-effort:
      // a house that exists without a checklist is recoverable (the PUT below
      // upserts), whereas a create that half-succeeded and then reported
      // failure would leave the RA re-entering an address that now conflicts.
      // Existing houses are never backfilled -- see summarizeSetup.
      try {
        await storage.createPropertySetupItems(
          setupItemsFor(property.ownership).map((item) => ({
            propertyId: property.id,
            itemKey: item.key,
            status: "open" as const,
            region: property.region,
          })),
        );
      } catch (error) {
        logError("Failed to seed the property setup checklist", error);
      }

      res.json(property);
    } catch (error) {
      // Validation failures are turned into a 400 by sendError. The raw error
      // message is deliberately not echoed back -- it used to be, and for a
      // database fault that meant returning column and constraint names.
      sendError(res, error, "Failed to create property");
    }
  });

  app.patch('/api/properties/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageProperties")) return;

      const existingProperty = await storage.getProperty(req.params.id);
      if (!existingProperty) {
        return res.status(404).json({ message: "Property not found" });
      }

      const validatedData = insertPropertySchema.partial().parse(req.body);

      if (!requireRegionMove(res, ctx, existingProperty.region, validatedData.region)) return;
      await requireOwnUploads(ctx, validatedData, ["photoUrl"], existingProperty);

      // If address components are being updated, recompute the full address
      const updateData: Partial<InsertPropertyWithAddress> = { ...validatedData };
      if (validatedData.streetAddress || validatedData.city || validatedData.state || validatedData.zipCode) {
        const streetAddress = validatedData.streetAddress || existingProperty.streetAddress;
        const city = validatedData.city || existingProperty.city;
        const state = validatedData.state || existingProperty.state;
        const zipCode = validatedData.zipCode || existingProperty.zipCode;
        updateData.address = `${streetAddress}, ${city}, ${state} ${zipCode}`;
      }
      
      const property = await storage.updateProperty(req.params.id, updateData);
      await removeDeletedRecordFiles(replacedFileUrls(existingProperty, validatedData, ["photoUrl"]));

      // Properties now carry document references -- the lease link and the
      // front-of-house photo -- and CLAUDE.md's standing rule is that anything
      // changing documents is recorded. Only these three fields, so an
      // ordinary edit to a bedroom count does not fill the trail with noise.
      const DOCUMENT_FIELDS = ["leaseDocumentUrl", "maintenancePortalUrl", "photoUrl"];
      const documentFields = changedFields(
        existingProperty as unknown as Record<string, unknown>,
        updateData as Record<string, unknown>,
      ).filter((field) => DOCUMENT_FIELDS.includes(field));
      if (documentFields.length > 0) {
        recordAuditEvent(ctx, {
          action: AUDIT_ACTIONS.PROPERTY_DOCUMENTS_CHANGED,
          entityType: "property",
          entityId: property.id,
          summary: `Changed ${documentFields.join(", ")} on ${property.name} (${property.address})`,
          details: { fields: documentFields, region: property.region },
        });
      }

      res.json(property);
    } catch (error) {
      sendError(res, error, "Failed to update property");
    }
  });

  app.delete('/api/properties/:id', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageProperties")) return;

      const existingProperty = await storage.getProperty(req.params.id);
      if (!existingProperty) {
        return res.status(404).json({ message: "Property not found" });
      }

      if (!requireRegion(res, ctx, existingProperty.region)) return;

      // The roster goes with the house by cascade, and every HH fee, deposit
      // and deduction goes with the roster. None of that can be rebuilt, so a
      // house still holding any of it stays.
      const refusal = propertyDeleteRefusal(
        existingProperty.name,
        await storage.getPropertyDeleteBlockers(req.params.id),
      );
      if (refusal) return res.status(409).json({ message: refusal });

      await removeDeletedRecordFiles(await storage.deleteProperty(req.params.id));
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.PROPERTY_DELETED,
        entityType: "property",
        entityId: existingProperty.id,
        summary: `Deleted ${existingProperty.name} (${existingProperty.address})`,
        details: { region: existingProperty.region },
      });
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete property");
    }
  });

  /**
   * A message to everybody currently living in a house.
   *
   * Active residents only, and one message per person rather than one
   * addressed to the whole list -- a mail-out to people who moved out last
   * spring is the kind of mistake that gets a tool abandoned, and nobody's
   * address should be disclosed to the rest of the house.
   *
   * A send failure never fails this request. `sendEmail` returns a result
   * rather than throwing, and email being unconfigured is a normal state, so
   * the response reports how many people it *addressed* and the trail records
   * that the house was emailed.
   */
  app.post('/api/properties/:propertyId/email', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageProperties")) return;

      const property = await propertyForSetup(req, res, ctx);
      if (!property) return;

      const body = z
        .object({
          subject: z.string().trim().min(1, "Give the message a subject").max(200),
          body: z.string().trim().min(1, "Write a message").max(5000),
        })
        .parse(req.body);

      const residents = await storage.getResidentsByProperty(property.id);
      const messages = householdEmail(residents, property.name, body.subject, body.body);

      // Fired without awaiting each one: this is a courtesy attached to
      // something the RA has already decided to do, and eight round trips to
      // a mail provider should not hold the response open.
      for (const message of messages) {
        void sendEmail(message);
      }

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.PROPERTY_HOUSEHOLD_EMAILED,
        entityType: "property",
        entityId: property.id,
        // The subject and the count, never the body: a summary is bounded and
        // a house mail-out can run to pages.
        summary: `Emailed ${messages.length} resident${messages.length === 1 ? "" : "s"} at ${property.name}: ${body.subject}`,
        details: { recipients: messages.length, region: property.region },
      });

      res.json({ recipients: messages.length });
    } catch (error) {
      sendError(res, error, "Failed to email the household");
    }
  });

  // ---------------------------------------------------------------------------
  // Per-property setup checklist
  //
  // What has to happen when SPO takes on a house, and where each of those
  // things stands. A dedicated table rather than a `tasks` row -- the reasoning
  // is in shared/propertySetup.ts, which also owns the item list and the
  // counts, so a screen never computes its own.
  //
  // Staff only. A household leader is told what is set up by their RA, not by
  // a screen that would also let them change it.
  // ---------------------------------------------------------------------------

  /** The property, once, with the checks a setup route always makes. */
  async function propertyForSetup(req: any, res: any, ctx: AuthContext) {
    const property = await storage.getProperty(req.params.propertyId);
    if (!property) {
      res.status(404).json({ message: "Property not found" });
      return undefined;
    }
    if (!requireRegion(res, ctx, property.region)) return undefined;
    return property;
  }

  /**
   * Every checklist row the caller can see, in one request.
   *
   * The badge on each property list row needs a house's counts before anybody
   * opens it, and one request per row would be a query per house on a page
   * that already lists them all.
   */
  app.get('/api/property-setup-items', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewProperties", "canManageProperties", "canManagePropertySetup")) return;

      res.json(filterByRegion(ctx, await storage.getAllPropertySetupItems()));
    } catch (error) {
      sendError(res, error, "Failed to fetch the setup checklists");
    }
  });

  app.get('/api/properties/:propertyId/setup', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewProperties", "canManageProperties", "canManagePropertySetup")) return;

      const property = await propertyForSetup(req, res, ctx);
      if (!property) return;

      res.json(await storage.getPropertySetupItems(property.id));
    } catch (error) {
      sendError(res, error, "Failed to fetch the setup checklist");
    }
  });

  /**
   * Sets one checklist item.
   *
   * A PUT on (property, item) rather than a POST of a row: the pair is unique
   * and the request is idempotent, and the storage method upserts so a house
   * created before the checklist existed can still be filled in.
   *
   * Three things come from the server and never from the body -- who set it,
   * when, and the region -- because "who said the gas was on" is exactly the
   * question this record exists to answer, and an answer the client supplied
   * would be worth nothing.
   */
  app.put('/api/properties/:propertyId/setup/:itemKey', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManagePropertySetup", "canManageProperties")) return;

      const property = await propertyForSetup(req, res, ctx);
      if (!property) return;

      // The item list is fixed in code, so an unknown key is a client error
      // rather than a new row: accepting it would write something no summary
      // ever reads. An item belonging to the other kind of house is refused
      // for the same reason.
      const allowed = setupItemsFor(property.ownership);
      if (!allowed.some((item) => item.key === req.params.itemKey)) {
        return res.status(400).json({
          message: SETUP_ITEMS.some((item) => item.key === req.params.itemKey)
            ? "That item does not apply to this kind of property"
            : "Unknown checklist item",
        });
      }

      const body = setPropertySetupItemSchema.parse(req.body);

      const item = await storage.setPropertySetupItem(property.id, req.params.itemKey, {
        status: body.status ?? "open",
        note: body.note ?? null,
        region: property.region,
        setByUserId: ctx.userId,
        setAt: new Date(),
      });

      res.json(item);
    } catch (error) {
      sendError(res, error, "Failed to update the setup checklist");
    }
  });

  // ─── House facts ───────────────────────────────────────────────────────────
  // What a household needs to know about their house (ADR-0002). Staff read
  // and write it here, region-checked like the setup checklist; the household
  // reads it through /api/my-property and never through these routes.

  app.get('/api/properties/:propertyId/facts', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canViewProperties", "canManageProperties")) return;

      const property = await propertyForSetup(req, res, ctx);
      if (!property) return;

      res.json((await storage.getPropertyFacts(property.id)) ?? null);
    } catch (error) {
      sendError(res, error, "Failed to fetch the house facts");
    }
  });

  /**
   * Saves the whole block.
   *
   * The body carries the nine content fields and nothing about dates: each
   * code's last-changed stamp is decided here, from whether its value actually
   * changed against the row already stored, so a re-save of the same code
   * leaves the date alone and a client cannot make a stale code look rotated.
   *
   * Every code that changed records its own audit event naming the house and
   * which code -- and never the value, which is why the details carry the
   * column name and the summary is built from the label. Changing the parking
   * rules or the rubbish day records nothing.
   */
  app.put('/api/properties/:propertyId/facts', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageProperties")) return;

      const property = await propertyForSetup(req, res, ctx);
      if (!property) return;

      const incoming = setPropertyFactsSchema.parse(req.body);
      const existing = await storage.getPropertyFacts(property.id);
      const plan = planHouseFacts(existing, incoming, new Date());

      const facts = await storage.upsertPropertyFacts(property.id, plan.write);

      for (const code of plan.changedCodes) {
        recordAuditEvent(ctx, {
          action: AUDIT_ACTIONS.PROPERTY_ACCESS_CODE_CHANGED,
          entityType: "property",
          entityId: property.id,
          summary: `${code.label} for ${property.name} (${property.address}) changed`,
          details: { field: code.key, region: property.region },
        });
      }

      res.json(facts);
    } catch (error) {
      sendError(res, error, "Failed to save the house facts");
    }
  });

  // ─── Uploaded files ────────────────────────────────────────────────────────
  // Requires a valid session. These files include maintenance and walkthrough
  // photos as well as W-9s, COIs and contract invoices, so they must never be
  // downloadable by an anonymous visitor who guesses a filename.
  app.get('/uploads/:filename', isAuthenticated, async (req, res) => {
    // A session alone is not enough: a deactivated account keeps its cookie
    // until it expires, and must not be able to keep pulling documents.
    //
    // The whole body is wrapped, because Express 4 does not forward a rejected
    // promise from an async handler to the error middleware. An unwrapped
    // failure here -- the account lookup below reaches the database -- would
    // leave the browser waiting until it timed out.
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;

      const requested = req.params.filename;

      // Reject anything that is not a bare filename, so a crafted key cannot
      // reach outside the uploads prefix in the bucket.
      if (!isSafeStorageKey(requested)) {
        return res.status(400).json({ message: "Invalid filename" });
      }

      const upload = await storage.getUploadByStorageKey(requested);

      // Authorized before existence is checked, so that a refusal looks the
      // same whether or not the file is there. Otherwise the difference between
      // 403 and 404 would confirm which filenames are real.
      if (!(await canReadUpload(ctx, requested, upload))) {
        return res.status(403).json({ message: "Forbidden" });
      }

      if (!(await uploadExists(requested))) {
        return res.status(404).json({ message: "File not found" });
      }

      // Photos are viewed constantly -- every card in every list pulls one --
      // so recording them would drown the log. Documents are the ones somebody
      // may later need to know were taken out: W-9s, COIs, contract invoices.
      if (upload?.contentType && !upload.contentType.startsWith("image/")) {
        recordAuditEvent(ctx, {
          action: AUDIT_ACTIONS.DOCUMENT_DOWNLOADED,
          entityType: "upload",
          entityId: requested,
          summary: `Downloaded ${upload.originalName}`,
          details: { contentType: upload.contentType },
        });
      }

      // Where the store can issue one, hand the browser a short-lived direct
      // link instead of relaying the bytes. The link expires quickly, and it is
      // only ever produced after the check above has passed.
      const signedUrl = await createUploadSignedUrl(requested);
      if (signedUrl) {
        // The redirect itself must never be cached: it carries a credential
        // that stops working, and the next request has to be re-authorized.
        res.setHeader("Cache-Control", "private, no-store");
        return res.redirect(302, signedUrl);
      }

      // "private" keeps authenticated content out of shared/proxy caches.
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("Content-Type", upload?.contentType ?? contentTypeFor(requested));

      if (upload?.originalName) {
        // Offers the file under the name the person chose rather than the
        // random key. Quotes and control characters are stripped from the
        // plain form because an unescaped one would let a filename inject a
        // header; the encoded form carries the exact name.
        const fallback = upload.originalName.replace(/[^\w.\- ]/g, "_");
        res.setHeader(
          "Content-Disposition",
          `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(upload.originalName)}`,
        );
      }

      const stream = await openUploadStream(requested);

      // If the client disconnects part way through, stop pulling bytes out of
      // the bucket instead of leaving the download running.
      res.on("close", () => stream.destroy());

      stream.on("error", (error) => {
        logError("Error streaming uploaded file", error);
        // Detach first, so no further bytes can race the response below.
        stream.unpipe(res);
        if (res.headersSent) {
          // Part of the file has already gone out, so the only honest signal
          // left is to break the connection rather than end it normally and
          // let the client treat a truncated file as complete. This is why the
          // stream error is handled here instead of through sendError, which
          // ends such a response cleanly.
          res.destroy();
        } else {
          res.status(500).json({ message: "Failed to load file" });
        }
      });

      stream.pipe(res);
    } catch (error) {
      sendError(res, error, "Failed to load file");
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

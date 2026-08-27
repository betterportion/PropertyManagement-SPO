import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, isAuthenticated, getUserId } from "./auth";
import {
  loadAuthContext,
  requireActiveUser,
  hasPermission,
  requirePermission,
  requireStaff,
  requireAdmin,
  requireRegion,
  requireRegionMove,
  requireMaintenanceRequestAccess,
  canReadMaintenanceRequest,
  residentHouseAddress,
  canReadUpload,
  filterByRegion,
  filterByRelatedRegion,
  canSeeTask,
  type AuthContext,
} from "./authz";
import { z } from "zod";
import { sendError, logError } from "./errors";
import { recordAuditEvent, auditLookup, changedFields, AUDIT_ACTIONS } from "./audit";
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
} from "./uploadLimits";
import { uploadRateLimit } from "./security";
import {
  insertMaintenanceRequestSchema,
  insertWalkthroughRoomSchema,
  insertWalkthroughPhotoSchema,
  insertAssetSchema,
  insertAssetPhotoSchema,
  insertMaintenanceContactSchema,
  insertInvoiceSchema,
  insertBillingRecordSchema,
  insertPropertySchema,
  insertUserSchema,
  insertMaintenanceScheduleSchema,
  insertResidentSchema,
  insertRentPaymentSchema,
  insertSecurityDepositSchema,
  insertTaskSchema,
  type InsertPropertyWithAddress,
} from "@shared/schema";
import { STANDARD_SCHEDULE_TEMPLATES, addMonths } from "./schedules";
import { buildActionItems } from "./actionItems";
import { buildRegionSummaries, type RegionStaff } from "./regionSummary";
import { normalizeRegions } from "./migrateRegions";
import { REGIONS } from "@shared/regions";

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

const roleUpdateSchema = z.object({
  role: z.enum(["admin", "regional_administrator", "resident"]),
});

const statusUpdateSchema = z.object({
  isActive: z.boolean(),
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
  from: blankAsAbsent(isoDate),
  to: blankAsAbsent(isoDate),
});

/**
 * Shared guard for linking and unlinking a vendor contact on a maintenance
 * request. Both sides of the relationship are checked: it is not enough to
 * reach the request if the contact belongs to another region, because linking
 * exposes that contact's details to everyone who can read the request.
 *
 * Returns false having already sent a response when access is denied.
 */
/**
 * Region guard for a walkthrough room, whose region comes from the property it
 * belongs to rather than from the room itself.
 *
 * Fails closed for non-admins when the region cannot be resolved -- an
 * unattached room, or one pointing at a property that no longer exists. This
 * matches how the room list filters, so a room that a user cannot see in the
 * list is also one they cannot edit or delete by ID.
 */
async function requireRoomRegion(
  res: import("express").Response,
  ctx: AuthContext,
  propertyId: string | null | undefined,
): Promise<boolean> {
  if (ctx.isAdmin) return true;

  const property = propertyId ? await storage.getProperty(propertyId) : undefined;
  // requireRegion rejects an undefined region, which is the behaviour we want
  // here, and keeps the denial message consistent with every other route.
  return requireRegion(res, ctx, property?.region);
}

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

export async function registerRoutes(app: Express): Promise<Server> {
  await setupAuth(app);

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
      const previous = await auditLookup(() => storage.getUser(req.params.id));
      const user = await storage.updateUserRole(req.params.id, validatedData.role);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
        entityType: "user",
        entityId: req.params.id,
        summary: `Changed ${previous?.email ?? req.params.id} from ${previous?.role ?? "unknown"} to ${validatedData.role}`,
        details: { from: previous?.role ?? null, to: validatedData.role },
      });

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
      const previous = await auditLookup(() => storage.getUser(req.params.id));
      const user = await storage.updateUserActiveStatus(req.params.id, isActive);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.USER_STATUS_CHANGED,
        entityType: "user",
        entityId: req.params.id,
        summary: `${isActive ? "Reactivated" : "Deactivated"} ${previous?.email ?? req.params.id}`,
        details: { isActive },
      });

      res.json(user);
    } catch (error) {
      sendError(res, error, "Failed to update user status");
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
          ? `Linked ${target.email ?? req.params.id} to ${property.name}`
          : `Unlinked ${target.email ?? req.params.id} from their house`,
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
      const permissions = await storage.getUserPermissions(req.params.id);
      if (!permissions) {
        return res.status(404).json({ message: "Permissions not found" });
      }
      res.json(permissions);
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
      const existingPermissions = await auditLookup(() => storage.getUserPermissions(req.params.id));
      const permissions = await storage.upsertUserPermissions({
        userId: req.params.id,
        ...filteredData,
      });

      // Field names and the region list only. A permissions row is all
      // booleans plus regions, so this is the whole change without storing a
      // copy of the request.
      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.USER_PERMISSIONS_CHANGED,
        entityType: "user",
        entityId: req.params.id,
        summary: `Changed permissions for ${req.params.id}`,
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
      const user = await storage.upsertUser({
        id: req.body.id || undefined,
        ...validatedData,
      });

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.USER_CREATED,
        entityType: "user",
        entityId: user.id,
        summary: `Created account ${user.email ?? user.id} with role ${user.role ?? "resident"}`,
        details: { role: user.role ?? null, isActive: user.isActive ?? null },
      });

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
        summary: `Deleted account ${previous?.email ?? req.params.id}`,
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
        from: from ? startOfUtcDay(from) : undefined,
        // The end of the range is a day the reader picked, and they mean it
        // inclusively -- so the bound sent down is the following midnight,
        // which the storage layer treats as exclusive.
        to: to ? nextUtcDay(to) : undefined,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });

      res.json({ events, total, page, pageSize });
    } catch (error) {
      sendError(res, error, "Failed to fetch the activity log");
    }
  });

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
        // the property list. Their request is filed against the house they are
        // on the roster for, matched by their login email. Region and building
        // come from that record, exactly as they do for rent and deposits.
        const residency = await storage.getActiveResidentByEmail(submittedBy);
        if (!residency) {
          return res.status(400).json({
            message:
              "We couldn't find your house on file. Ask your house director to add you to a house, then try again.",
          });
        }
        const validatedData = insertMaintenanceRequestSchema
          .omit({ region: true, buildingAddress: true, submittedBy: true })
          .parse(req.body);
        const request = await storage.createMaintenanceRequest({
          ...validatedData,
          region: residency.region,
          buildingAddress: residency.buildingAddress,
          submittedBy,
        });
        await attachRequestPhotos(ctx, request.id, req.body?.photoUrls);
        return res.json(request);
      }

      // Staff file into a region they can reach. submittedBy is still the
      // session, so it is omitted from the body here too.
      const validatedData = insertMaintenanceRequestSchema.omit({ submittedBy: true }).parse(req.body);
      if (!requireRegion(res, ctx, validatedData.region, "Forbidden - Cannot create in this region")) return;

      const request = await storage.createMaintenanceRequest({ ...validatedData, submittedBy });
      await attachRequestPhotos(ctx, request.id, req.body?.photoUrls);
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
      // request in their region.
      const isUploader = photo.uploadedBy === (ctx.user.email || "");
      if (ctx.isResident && !isUploader) {
        return res.status(403).json({ message: "Forbidden" });
      }
      await storage.deleteMaintenanceRequestPhoto(req.params.id);
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

      if (!requireRegionMove(res, ctx, existingRequest.region, validatedData.region)) return;

      const request = await storage.updateMaintenanceRequest(req.params.id, validatedData);

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

      await storage.deleteMaintenanceRequest(req.params.id);
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
      // is already allowed to read: residents through ownership or their house,
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

  // Walkthrough Rooms Routes
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

      if (validatedData.propertyId) {
        const property = await storage.getProperty(validatedData.propertyId);
        if (!property) {
          return res.status(404).json({ message: "Property not found" });
        }
        if (!requireRegion(res, ctx, property.region, "Forbidden - Cannot create in this region")) return;
      }

      const room = await storage.createWalkthroughRoom(validatedData);
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

      if (!(await requireRoomRegion(res, ctx, existingRoom.propertyId))) return;

      const validatedData = insertWalkthroughRoomSchema.partial().parse(req.body);

      if (validatedData.propertyId && validatedData.propertyId !== existingRoom.propertyId) {
        const targetProperty = await storage.getProperty(validatedData.propertyId);
        if (!targetProperty) {
          return res.status(404).json({ message: "Property not found" });
        }
        if (!requireRegion(res, ctx, targetProperty.region, "Forbidden - Cannot move to this region")) return;
      }

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

      if (!(await requireRoomRegion(res, ctx, existingRoom.propertyId))) return;

      await storage.deleteWalkthroughRoom(req.params.id);
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

      if (!requireRegion(res, ctx, validatedData.region, "Forbidden - Cannot create in this region")) return;

      // Attribution comes from the session, never the body, so a caller cannot
      // credit a photo to someone else (matches submittedBy on requests).
      const photo = await storage.createWalkthroughPhoto({
        ...validatedData,
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

      const validatedData = insertWalkthroughPhotoSchema.partial().parse(req.body);

      if (!requireRegionMove(res, ctx, existingPhoto.region, validatedData.region)) return;

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

      await storage.deleteWalkthroughPhoto(req.params.id);
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

      const assets = await storage.getAllAssets();
      res.json(filterByRegion(ctx, assets));
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

      await storage.deleteAsset(req.params.id);
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete asset");
    }
  });

  // Middleware: rejects the request with 403 before multer reads a single byte
  // when the caller is deactivated or lacks a role that legitimately needs
  // file-storage access (residents are not permitted to upload directly).
  const requireUploadPermission: import("express").RequestHandler = async (req: any, res, next) => {
    try {
      const ctx = await loadAuthContext(req);
      if (!ctx) {
        return res.status(403).json({ message: "Your account is not active." });
      }
      if (ctx.isResident) {
        return res.status(403).json({ message: "Residents are not permitted to upload files." });
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
  app.post('/api/upload', isAuthenticated, uploadRateLimit, requireUploadPermission, ...guardedUpload(upload.single('file'), IMAGE_UPLOAD_MAX_BYTES), async (req: any, res) => {
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

  app.post('/api/upload-doc', isAuthenticated, uploadRateLimit, requireUploadPermission, ...guardedUpload(docUpload.single('file'), DOCUMENT_UPLOAD_MAX_BYTES), async (req: any, res) => {
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

      await storage.deleteAssetPhoto(req.params.id);
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
      const resident = await storage.updateResident(req.params.id, validatedData);
      res.json(resident);
    } catch (error) {
      sendError(res, error, "Failed to update resident");
    }
  });

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

      const account = await storage.getActiveResidentAccountByEmail(resident.email);
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

      // Through the shared schema so the date string becomes a Date the same
      // way every other resident write does.
      const updated = await storage.updateResident(
        req.params.id,
        insertResidentSchema.partial().parse({ isActive: false, moveOutDate }),
      );

      // Bounded on purpose: only an *active, resident-role* login matching
      // this roster row's email can be switched off here, and this route only
      // ever deactivates. Reactivation stays an admin action in Settings.
      let accountDeactivated = false;
      if (deactivateAccount) {
        const account = await storage.getActiveResidentAccountByEmail(resident.email);
        if (account) {
          await storage.updateUserActiveStatus(account.id, false);
          accountDeactivated = true;
          recordAuditEvent(ctx, {
            action: AUDIT_ACTIONS.USER_STATUS_CHANGED,
            entityType: "user",
            entityId: account.id,
            summary: `Deactivated ${account.email ?? account.id}'s login while moving them out of ${resident.buildingAddress}`,
            details: { isActive: false, reason: "move_out", residentId: resident.id },
          });
        }
      }

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

      await storage.deleteResident(req.params.id);
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
        summary: `Recorded ${payment.period} rent of ${payment.amount ?? "an unstated amount"} for a resident at ${payment.buildingAddress} (${payment.status})`,
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
      if (!/^\d{4}-\d{2}$/.test(period ?? "")) {
        return res.status(400).json({ message: "Use a YYYY-MM month" });
      }
      const property = await storage.getProperty(propertyId);
      if (!property) {
        return res.status(404).json({ message: "Property not found" });
      }
      if (!requireRegion(res, ctx, property.region, "Forbidden - Cannot record in this region")) return;

      const amount = req.body.amount ?? (await storage.getLatestRentAmountForProperty(property.id));
      if (amount === undefined || amount === null || amount === "") {
        return res.status(400).json({ message: "Enter an amount -- there is no previous rent for this house to copy." });
      }

      const roster = await storage.getResidentsByProperty(property.id);
      const current = roster.filter((r) => r.isActive);
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
          summary: `Recorded ${payment.period} rent of ${payment.amount ?? "an unstated amount"} for a resident at ${payment.buildingAddress} (${payment.status})`,
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
        return res.status(404).json({ message: "Rent payment not found" });
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
        summary: `Updated ${existing.period} rent for a resident at ${existing.buildingAddress} (now ${payment.status})`,
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
        return res.status(404).json({ message: "Rent payment not found" });
      }
      if (!requireRegion(res, ctx, existing.region)) return;

      await storage.deleteRentPayment(req.params.id);

      recordAuditEvent(ctx, {
        action: AUDIT_ACTIONS.RENT_PAYMENT_DELETED,
        entityType: "rent_payment",
        entityId: req.params.id,
        summary: `Deleted ${existing.period} rent of ${existing.amount ?? "an unstated amount"} for a resident at ${existing.buildingAddress}`,
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

  // Action items + Tasks Routes
  //
  // "Action items" are the dashboard's derived list -- unpaid rent, deposits to
  // return, maintenance coming due -- plus the open manual tasks the caller can
  // see. Nothing here creates finance data; resolving a derived item happens on
  // its own (already-audited) endpoint. The surface itself is regional-leads-
  // only (requireStaff); the finance-derived items additionally follow the
  // finance flags, so revoking someone's finance access also empties their
  // dashboard of rent and deposit items rather than leaking them here.
  app.get('/api/action-items', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      const seesFinance = hasPermission(ctx, "canViewFinancials", "canManageFinancials");

      const [schedules, rentPayments, deposits, residents, allTasks, properties] = await Promise.all([
        storage.getAllMaintenanceSchedules(),
        seesFinance ? storage.getAllRentPayments() : [],
        seesFinance ? storage.getAllSecurityDeposits() : [],
        storage.getAllResidents(),
        storage.getAllTasks(),
        storage.getAllProperties(),
      ]);

      const items = buildActionItems({
        // Derived items are region-scoped exactly like their source lists.
        schedules: filterByRegion(ctx, schedules),
        rentPayments: filterByRegion(ctx, rentPayments),
        deposits: filterByRegion(ctx, deposits),
        // Residents are only used to tell which deposits belong to someone who
        // moved out; they need not be filtered (the deposits already are).
        residents,
        tasks: allTasks.filter((t) => canSeeTask(ctx, t)),
        properties: filterByRegion(ctx, properties),
      });
      res.json(items);
    } catch (error) {
      sendError(res, error, "Failed to load action items");
    }
  });

  // Per-region rollup for the leadership dashboard. An admin sees every region;
  // a regional admin sees only the region(s) they are assigned. Regional-leads
  // only, same audience as the action-items route.
  app.get('/api/region-summary', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      // Same rule as action items: the rollup is staff-wide, but its rent
      // figures follow the finance flags.
      const seesFinance = hasPermission(ctx, "canViewFinancials", "canManageFinancials");

      const [requests, schedules, properties, rentPayments, tasks, users, permissions] = await Promise.all([
        storage.getAllMaintenanceRequests(),
        storage.getAllMaintenanceSchedules(),
        storage.getAllProperties(),
        seesFinance ? storage.getAllRentPayments() : [],
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
          tasks: filterByRegion(ctx, tasks),
          staff,
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

      // Scope rules. A personal task ("just me") belongs to the creator and needs
      // no region. A region broadcast must be a region the creator can reach. An
      // all-regions broadcast (no region) is an admin-only announcement.
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

  app.post('/api/invoices', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageBilling")) return;

      const validatedData = insertInvoiceSchema.parse(req.body);

      if (!requireRegion(res, ctx, validatedData.region, "Forbidden - Cannot create in this region")) return;

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

  app.post('/api/billing', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requireStaff(res, ctx)) return;
      if (!requirePermission(res, ctx, "canManageBilling")) return;

      const { createContact, ...rest } = req.body;
      const validatedData = insertBillingRecordSchema.parse(rest);

      if (!requireRegion(res, ctx, validatedData.region, "Forbidden - Cannot create in this region")) return;

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

      const record = await storage.updateBillingRecord(req.params.id, validatedData);

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

      await storage.deleteBillingRecord(req.params.id);

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

      // Compute full address from components
      const address = `${validatedData.streetAddress}, ${validatedData.city}, ${validatedData.state} ${validatedData.zipCode}`;
      const property = await storage.createProperty({ ...validatedData, address });
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

      await storage.deleteProperty(req.params.id);
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, "Failed to delete property");
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

import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, isAuthenticated, getUserId } from "./auth";
import {
  loadAuthContext,
  requireActiveUser,
  requirePermission,
  requireStaff,
  requireAdmin,
  requireRegion,
  requireRegionMove,
  requireMaintenanceRequestAccess,
  canReadMaintenanceRequest,
  canReadUpload,
  filterByRegion,
  filterByRelatedRegion,
  type AuthContext,
} from "./authz";
import { z } from "zod";
import { sendError, logError } from "./errors";
import { recordAuditEvent, auditLookup, changedFields, AUDIT_ACTIONS } from "./audit";
import { AUDIT_ACTION_VALUES } from "@shared/audit";
import multer from "multer";
import path from "path";
import crypto from "crypto";
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
import { uploadRateLimit, webhookRateLimit } from "./security";
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
  type InsertPropertyWithAddress,
} from "@shared/schema";

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

// Constant-time string comparison, so a wrong secret cannot be discovered by
// measuring how long the comparison takes.
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

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
      // can never disagree about what a user is allowed to see.
      const filteredRequests = requests.filter((request) =>
        canReadMaintenanceRequest(ctx, request),
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

      if (!requireMaintenanceRequestAccess(res, ctx, request)) return;

      res.json(request);
    } catch (error) {
      sendError(res, error, "Failed to fetch maintenance request");
    }
  });

  app.post('/api/maintenance-requests', isAuthenticated, async (req: any, res) => {
    try {
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!requirePermission(res, ctx, "canViewMaintenance", "canManageMaintenance")) return;

      const validatedData = insertMaintenanceRequestSchema.parse(req.body);

      // Residents are scoped by ownership rather than by region -- they are
      // never assigned regions, and they can only ever read back the requests
      // they submitted, so a region check here would block them entirely
      // without preventing any cross-region disclosure.
      if (!ctx.isResident) {
        if (!requireRegion(res, ctx, validatedData.region, "Forbidden - Cannot create in this region")) return;
      }

      // The submitter is taken from the session, never from the request body,
      // so a caller cannot file a request in someone else's name.
      const request = await storage.createMaintenanceRequest({
        ...validatedData,
        submittedBy: ctx.user.email || "Unknown",
      });

      res.json(request);
    } catch (error) {
      sendError(res, error, "Failed to create maintenance request");
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
      // is already allowed to read: residents through ownership, staff through
      // region. Previously any signed-in user could read the contacts on any
      // request by guessing its ID.
      if (!requireMaintenanceRequestAccess(res, ctx, request)) return;

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

  // ─── JotForm Webhook ───────────────────────────────────────────────────────
  // Called by JotForm's servers, so it cannot use session auth. It is guarded
  // by a shared secret instead, passed as ?secret=... on the webhook URL.
  // Configure in JotForm: Settings → Integrations → WebHooks → add this URL
  //
  // JotForm delivers submissions as multipart/form-data, which the JSON and
  // urlencoded parsers upstream do not read — without this parser req.body
  // arrives empty and every submission silently degrades to its defaults.
  // Text fields only: JotForm sends uploaded files as links inside rawRequest,
  // never as file parts, so a request carrying an actual file part is refused.
  // The limits bound what an unauthenticated caller can make this parser hold
  // in memory; the rate limit above it bounds how often they can try.
  const jotformFormParser = multer({
    limits: { fields: 100, fieldSize: 256 * 1024, fileSize: 1 },
  }).none();

  app.post('/api/webhooks/jotform', webhookRateLimit, jotformFormParser, async (req, res) => {
    try {
      // Fail closed. If no secret is configured the endpoint is disabled
      // entirely, rather than silently accepting anonymous submissions.
      const secret = process.env.JOTFORM_WEBHOOK_SECRET;
      if (!secret) {
        console.error(
          "Rejected JotForm webhook: JOTFORM_WEBHOOK_SECRET is not configured."
        );
        return res.status(503).json({ message: "Webhook not configured" });
      }

      const provided = req.query.secret ?? req.body?.secret;
      if (typeof provided !== "string" || !secretsMatch(provided, secret)) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      // Parse JotForm's rawRequest field (URL-encoded JSON string)
      let formFields: Record<string, any> = {};

      if (req.body.rawRequest) {
        try {
          formFields = JSON.parse(decodeURIComponent(req.body.rawRequest));
        } catch {
          formFields = req.body;
        }
      } else {
        formFields = req.body;
      }

      // Flatten compound fields (e.g., name: {first, last} → "John Doe")
      const flat: Record<string, string> = {};
      for (const [key, value] of Object.entries(formFields)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const parts = Object.values(value as Record<string, string>).filter(Boolean);
          flat[key] = parts.join(' ').trim();
        } else {
          flat[key] = String(value ?? '').trim();
        }
      }

      console.log('[JotForm] Received submission. Fields:', JSON.stringify(flat, null, 2));

      // Helper: look up a field by env-var field ID first, then auto-detect by key label
      const getField = (envKey: string, ...terms: string[]): string => {
        const envFieldId = process.env[envKey];
        if (envFieldId && flat[envFieldId] !== undefined) return flat[envFieldId];
        for (const [k, v] of Object.entries(flat)) {
          const kLower = k.toLowerCase();
          if (terms.some(t => kLower.includes(t.toLowerCase()))) return v;
        }
        return '';
      };

      // Map JotForm fields to maintenance request schema
      const title = getField('JOTFORM_FIELD_TITLE', 'title', 'subject', 'issue', 'request')
        || `Maintenance Request – ${new Date().toLocaleDateString()}`;

      const description = getField('JOTFORM_FIELD_DESCRIPTION', 'description', 'details', 'message', 'describe', 'notes', 'comment')
        || '';

      const rawCategory = getField('JOTFORM_FIELD_CATEGORY', 'category', 'type', 'problem');
      const VALID_CATEGORIES = ['HVAC', 'Appliance', 'Electrical', 'Plumbing', 'Structural', 'Furniture', 'IT / Electronics', 'Safety Equipment', 'Vehicle', 'Other', 'Plumbing', 'General Maintenance'];
      const category = VALID_CATEGORIES.find(c => c.toLowerCase() === rawCategory.toLowerCase()) || rawCategory || 'General Maintenance';

      const rawPriority = getField('JOTFORM_FIELD_PRIORITY', 'priority', 'urgency', 'severity').toLowerCase();
      const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent', 'wishlist'];
      const priority = (VALID_PRIORITIES.find(p => rawPriority.includes(p)) as any) || 'medium';

      const location = getField('JOTFORM_FIELD_LOCATION', 'location', 'unit', 'room', 'address', 'property')
        || process.env.JOTFORM_DEFAULT_LOCATION || 'Unknown';

      const region = getField('JOTFORM_FIELD_REGION', 'region')
        || process.env.JOTFORM_DEFAULT_REGION || 'Unknown';

      const buildingAddress = getField('JOTFORM_FIELD_BUILDING', 'building', 'buildingaddress', 'building_address')
        || process.env.JOTFORM_DEFAULT_BUILDING || location;

      const submittedBy = getField('JOTFORM_FIELD_EMAIL', 'email', 'name', 'submitter', 'contact', 'resident')
        || req.body.formTitle || 'JotForm Submission';

      const request = await storage.createMaintenanceRequest({
        title,
        description,
        category,
        priority,
        status: 'pending',
        location,
        region,
        buildingAddress,
        submittedBy,
      });

      console.log(`[JotForm] Created maintenance request ${request.id}: "${title}" (${priority} priority)`);
      res.status(200).json({ success: true, id: request.id });
    } catch (error) {
      sendError(res, error, 'Failed to process JotForm submission');
    }
  });

  // Return current webhook config info (admin + regional_administrator)
  app.get('/api/webhooks/jotform/config', isAuthenticated, async (req: any, res) => {
    try {
      // This response names which JotForm environment variables are set, so it
      // is deliberately narrower than the rest of the API: administrators only,
      // and only while their account is still active.
      const ctx = await requireActiveUser(req, res);
      if (!ctx) return;
      if (!ctx.isAdmin && ctx.user.role !== 'regional_administrator') {
        return res.status(403).json({ message: 'Admin or regional administrator only' });
      }
      res.json({
        webhookUrl: `${req.protocol}://${req.get('host')}/api/webhooks/jotform`,
        fields: {
          JOTFORM_FIELD_TITLE: process.env.JOTFORM_FIELD_TITLE || null,
          JOTFORM_FIELD_DESCRIPTION: process.env.JOTFORM_FIELD_DESCRIPTION || null,
          JOTFORM_FIELD_CATEGORY: process.env.JOTFORM_FIELD_CATEGORY || null,
          JOTFORM_FIELD_PRIORITY: process.env.JOTFORM_FIELD_PRIORITY || null,
          JOTFORM_FIELD_LOCATION: process.env.JOTFORM_FIELD_LOCATION || null,
          JOTFORM_FIELD_EMAIL: process.env.JOTFORM_FIELD_EMAIL || null,
          JOTFORM_FIELD_REGION: process.env.JOTFORM_FIELD_REGION || null,
          JOTFORM_FIELD_BUILDING: process.env.JOTFORM_FIELD_BUILDING || null,
          JOTFORM_DEFAULT_REGION: process.env.JOTFORM_DEFAULT_REGION || null,
          JOTFORM_DEFAULT_BUILDING: process.env.JOTFORM_DEFAULT_BUILDING || null,
          JOTFORM_DEFAULT_LOCATION: process.env.JOTFORM_DEFAULT_LOCATION || null,
          JOTFORM_WEBHOOK_SECRET: process.env.JOTFORM_WEBHOOK_SECRET ? '(set)' : null,
        },
      });
    } catch (error) {
      sendError(res, error, "Failed to load configuration");
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

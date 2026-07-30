import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, isAuthenticated, getUserId } from "./auth";
import { z } from "zod";
import multer from "multer";
import { createMondayItem, updateMondayItem } from "./monday";
import path from "path";
import crypto from "crypto";
import {
  generateUploadFilename,
  putUpload,
  uploadExists,
  openUploadStream,
  contentTypeFor,
} from "./objectStorage";
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
  limits: { fileSize: 10 * 1024 * 1024 },
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

function filterByRegion<T extends { region?: string | null }>(items: T[], allowedRegions: string[] | null): T[] {
  if (!allowedRegions || allowedRegions.length === 0) {
    return [];
  }
  if (allowedRegions.includes("all")) {
    return items;
  }
  return items.filter(item => item.region && allowedRegions.includes(item.region));
}

// Constant-time string comparison, so a wrong secret cannot be discovered by
// measuring how long the comparison takes.
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function canAccessRegion(region: string | null | undefined, allowedRegions: string[] | null, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  if (!region) return false;
  if (!allowedRegions || allowedRegions.length === 0) return false;
  return allowedRegions.includes(region);
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
      const permissions = await storage.getUserPermissions(userId);
      res.json({ ...user, permissions });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  app.get('/api/users', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      if (currentUser?.role !== "admin") {
        return res.status(403).json({ message: "Forbidden" });
      }
      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  app.patch('/api/users/:id/role', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      if (currentUser?.role !== "admin") {
        return res.status(403).json({ message: "Forbidden" });
      }
      const validatedData = roleUpdateSchema.parse(req.body);
      const user = await storage.updateUserRole(req.params.id, validatedData.role);
      res.json(user);
    } catch (error) {
      console.error("Error updating user role:", error);
      res.status(500).json({ message: "Failed to update user role" });
    }
  });

  app.patch('/api/users/:id/status', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      if (currentUser?.role !== "admin") {
        return res.status(403).json({ message: "Forbidden" });
      }
      const { isActive } = req.body;
      const user = await storage.updateUserActiveStatus(req.params.id, isActive);
      res.json(user);
    } catch (error) {
      console.error("Error updating user status:", error);
      res.status(500).json({ message: "Failed to update user status" });
    }
  });

  app.get('/api/users/:id/permissions', isAuthenticated, async (req: any, res) => {
    try {
      // A user may read only their own permissions. Admins may read anyone's.
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const isAdmin = currentUser?.role === "admin";
      if (!isAdmin && req.params.id !== userId) {
        return res.status(403).json({ message: "Forbidden" });
      }
      const permissions = await storage.getUserPermissions(req.params.id);
      if (!permissions) {
        return res.status(404).json({ message: "Permissions not found" });
      }
      res.json(permissions);
    } catch (error) {
      console.error("Error fetching permissions:", error);
      res.status(500).json({ message: "Failed to fetch permissions" });
    }
  });

  app.patch('/api/users/:id/permissions', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      if (currentUser?.role !== "admin") {
        return res.status(403).json({ message: "Forbidden" });
      }
      const validatedData = permissionsUpdateSchema.parse(req.body);
      const filteredData = Object.fromEntries(
        Object.entries(validatedData).filter(([_, v]) => v !== undefined)
      );
      const permissions = await storage.upsertUserPermissions({
        userId: req.params.id,
        ...filteredData,
      });
      res.json(permissions);
    } catch (error) {
      console.error("Error updating permissions:", error);
      res.status(500).json({ message: "Failed to update permissions" });
    }
  });

  app.post('/api/users', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      if (currentUser?.role !== "admin") {
        return res.status(403).json({ message: "Forbidden" });
      }
      const validatedData = insertUserSchema.parse(req.body);
      const user = await storage.upsertUser({
        id: req.body.id || undefined,
        ...validatedData,
      });
      res.json(user);
    } catch (error) {
      console.error("Error creating user:", error);
      res.status(500).json({ message: "Failed to create user" });
    }
  });

  app.delete('/api/users/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      if (currentUser?.role !== "admin") {
        return res.status(403).json({ message: "Forbidden" });
      }
      await storage.deleteUser(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting user:", error);
      res.status(500).json({ message: "Failed to delete user" });
    }
  });

  // Maintenance Requests Routes
  app.get('/api/maintenance-requests', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || (!permissions?.canViewMaintenance && !permissions?.canManageMaintenance)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const requests = await storage.getAllMaintenanceRequests();
      const allowedRegions = permissions?.allowedRegions || [];
      const isAdmin = currentUser?.role === "admin";
      const isResident = currentUser?.role === "resident";
      
      // Residents only see their own requests
      const filteredRequests = isAdmin
        ? requests
        : isResident
          ? requests.filter(r => r.submittedBy === userId)
          : filterByRegion(requests, allowedRegions);
      res.json(filteredRequests);
    } catch (error) {
      console.error("Error fetching maintenance requests:", error);
      res.status(500).json({ message: "Failed to fetch maintenance requests" });
    }
  });

  app.get('/api/maintenance-requests/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || (!permissions?.canViewMaintenance && !permissions?.canManageMaintenance)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const request = await storage.getMaintenanceRequest(req.params.id);
      if (!request) {
        return res.status(404).json({ message: "Maintenance request not found" });
      }
      
      const allowedRegions = permissions?.allowedRegions || [];
      const isAdmin = currentUser?.role === "admin";
      if (!isAdmin && request.region && !allowedRegions.includes(request.region)) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }
      
      res.json(request);
    } catch (error) {
      console.error("Error fetching maintenance request:", error);
      res.status(500).json({ message: "Failed to fetch maintenance request" });
    }
  });

  app.post('/api/maintenance-requests', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || (!permissions?.canViewMaintenance && !permissions?.canManageMaintenance)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const validatedData = insertMaintenanceRequestSchema.parse(req.body);
      
      if (validatedData.region && !canAccessRegion(validatedData.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Cannot create in this region" });
      }
      
      const request = await storage.createMaintenanceRequest({
        ...validatedData,
        submittedBy: currentUser.email || "Unknown",
      });

      createMondayItem({
        title: request.title,
        description: request.description,
        category: request.category,
        priority: request.priority,
        status: request.status,
        region: request.region,
        buildingAddress: request.buildingAddress,
        location: request.location,
        submittedBy: request.submittedBy,
      }).then(async (mondayItemId) => {
        if (mondayItemId) {
          await storage.updateMaintenanceRequest(request.id, { mondayItemId });
        }
      }).catch((err) => console.error("Monday.com async create failed:", err));

      res.json(request);
    } catch (error) {
      console.error("Error creating maintenance request:", error);
      res.status(500).json({ message: "Failed to create maintenance request" });
    }
  });

  app.patch('/api/maintenance-requests/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageMaintenance) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingRequest = await storage.getMaintenanceRequest(req.params.id);
      if (!existingRequest) {
        return res.status(404).json({ message: "Maintenance request not found" });
      }
      
      if (!canAccessRegion(existingRequest.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      const validatedData = insertMaintenanceRequestSchema.partial().parse(req.body);
      
      if (validatedData.region && validatedData.region !== existingRequest.region) {
        if (!canAccessRegion(validatedData.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
          return res.status(403).json({ message: "Forbidden - Cannot move to this region" });
        }
      }
      
      const request = await storage.updateMaintenanceRequest(req.params.id, validatedData);
      res.json(request);

      if (existingRequest.mondayItemId && (validatedData.status || validatedData.priority)) {
        updateMondayItem(
          existingRequest.mondayItemId,
          existingRequest.region,
          {
            status: validatedData.status ?? undefined,
            priority: validatedData.priority ?? undefined,
          }
        ).catch((err) => console.error("Monday.com async update failed:", err));
      }
    } catch (error) {
      console.error("Error updating maintenance request:", error);
      res.status(500).json({ message: "Failed to update maintenance request" });
    }
  });

  app.delete('/api/maintenance-requests/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageMaintenance) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingRequest = await storage.getMaintenanceRequest(req.params.id);
      if (!existingRequest) {
        return res.status(404).json({ message: "Maintenance request not found" });
      }
      
      if (!canAccessRegion(existingRequest.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      await storage.deleteMaintenanceRequest(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting maintenance request:", error);
      res.status(500).json({ message: "Failed to delete maintenance request" });
    }
  });

  // Linked Contacts for a Maintenance Request
  app.get('/api/maintenance-requests/:id/contacts', isAuthenticated, async (req: any, res) => {
    try {
      const contacts = await storage.getRequestContacts(req.params.id);
      res.json(contacts);
    } catch (error) {
      console.error("Error fetching request contacts:", error);
      res.status(500).json({ message: "Failed to fetch linked contacts" });
    }
  });

  app.post('/api/maintenance-requests/:id/contacts/:contactId', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      if (!currentUser?.isActive || currentUser.role === "resident") {
        return res.status(403).json({ message: "Forbidden" });
      }
      await storage.linkContactToRequest(req.params.id, req.params.contactId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error linking contact:", error);
      res.status(500).json({ message: "Failed to link contact" });
    }
  });

  app.delete('/api/maintenance-requests/:id/contacts/:contactId', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      if (!currentUser?.isActive || currentUser.role === "resident") {
        return res.status(403).json({ message: "Forbidden" });
      }
      await storage.unlinkContactFromRequest(req.params.id, req.params.contactId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error unlinking contact:", error);
      res.status(500).json({ message: "Failed to unlink contact" });
    }
  });

  // Walkthrough Rooms Routes
  app.get('/api/walkthrough-rooms', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || (!permissions?.canViewWalkthroughs && !permissions?.canManageWalkthroughs)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const rooms = await storage.getAllWalkthroughRooms();
      const properties = await storage.getAllProperties();
      const allowedRegions = permissions?.allowedRegions || [];
      const isAdmin = currentUser?.role === "admin";
      
      const filteredRooms = isAdmin ? rooms : rooms.filter(room => {
        const property = properties.find(p => p.id === room.propertyId);
        return property && allowedRegions.includes(property.region);
      });
      res.json(filteredRooms);
    } catch (error) {
      console.error("Error fetching walkthrough rooms:", error);
      res.status(500).json({ message: "Failed to fetch walkthrough rooms" });
    }
  });

  app.post('/api/walkthrough-rooms', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageWalkthroughs) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const validatedData = insertWalkthroughRoomSchema.parse(req.body);
      
      if (validatedData.propertyId) {
        const property = await storage.getProperty(validatedData.propertyId);
        if (property && !canAccessRegion(property.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
          return res.status(403).json({ message: "Forbidden - Cannot create in this region" });
        }
      }
      
      const room = await storage.createWalkthroughRoom(validatedData);
      res.json(room);
    } catch (error) {
      console.error("Error creating walkthrough room:", error);
      res.status(500).json({ message: "Failed to create walkthrough room" });
    }
  });

  app.patch('/api/walkthrough-rooms/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageWalkthroughs) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingRoom = await storage.getWalkthroughRoom(req.params.id);
      if (!existingRoom) {
        return res.status(404).json({ message: "Walkthrough room not found" });
      }
      
      if (existingRoom.propertyId) {
        const property = await storage.getProperty(existingRoom.propertyId);
        if (property && !canAccessRegion(property.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
          return res.status(403).json({ message: "Forbidden - Region not accessible" });
        }
      }

      const validatedData = insertWalkthroughRoomSchema.partial().parse(req.body);
      
      if (validatedData.propertyId && validatedData.propertyId !== existingRoom.propertyId) {
        const targetProperty = await storage.getProperty(validatedData.propertyId);
        if (targetProperty && !canAccessRegion(targetProperty.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
          return res.status(403).json({ message: "Forbidden - Cannot move to this region" });
        }
      }
      
      const room = await storage.updateWalkthroughRoom(req.params.id, validatedData);
      res.json(room);
    } catch (error) {
      console.error("Error updating walkthrough room:", error);
      res.status(500).json({ message: "Failed to update walkthrough room" });
    }
  });

  app.delete('/api/walkthrough-rooms/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageWalkthroughs) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingRoom = await storage.getWalkthroughRoom(req.params.id);
      if (!existingRoom) {
        return res.status(404).json({ message: "Walkthrough room not found" });
      }
      
      if (existingRoom.propertyId) {
        const property = await storage.getProperty(existingRoom.propertyId);
        if (property && !canAccessRegion(property.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
          return res.status(403).json({ message: "Forbidden - Region not accessible" });
        }
      }

      await storage.deleteWalkthroughRoom(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting walkthrough room:", error);
      res.status(500).json({ message: "Failed to delete walkthrough room" });
    }
  });

  // Walkthrough Photos Routes
  app.get('/api/walkthrough-photos', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || (!permissions?.canViewWalkthroughs && !permissions?.canManageWalkthroughs)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const photos = await storage.getAllWalkthroughPhotos();
      const allowedRegions = permissions?.allowedRegions || [];
      const isAdmin = currentUser?.role === "admin";
      const filteredPhotos = isAdmin ? photos : filterByRegion(photos, allowedRegions);
      res.json(filteredPhotos);
    } catch (error) {
      console.error("Error fetching walkthrough photos:", error);
      res.status(500).json({ message: "Failed to fetch walkthrough photos" });
    }
  });

  app.get('/api/walkthrough-photos/room/:roomId', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || (!permissions?.canViewWalkthroughs && !permissions?.canManageWalkthroughs)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const photos = await storage.getWalkthroughPhotosByRoom(req.params.roomId);
      const allowedRegions = permissions?.allowedRegions || [];
      const isAdmin = currentUser?.role === "admin";
      const filteredPhotos = isAdmin ? photos : filterByRegion(photos, allowedRegions);
      res.json(filteredPhotos);
    } catch (error) {
      console.error("Error fetching room photos:", error);
      res.status(500).json({ message: "Failed to fetch room photos" });
    }
  });

  app.post('/api/walkthrough-photos', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageWalkthroughs) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const validatedData = insertWalkthroughPhotoSchema.parse(req.body);
      
      if (validatedData.region && !canAccessRegion(validatedData.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Cannot create in this region" });
      }
      
      const photo = await storage.createWalkthroughPhoto(validatedData);
      res.json(photo);
    } catch (error) {
      console.error("Error creating walkthrough photo:", error);
      res.status(500).json({ message: "Failed to create walkthrough photo" });
    }
  });

  app.patch('/api/walkthrough-photos/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageWalkthroughs) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingPhoto = await storage.getWalkthroughPhoto(req.params.id);
      if (!existingPhoto) {
        return res.status(404).json({ message: "Walkthrough photo not found" });
      }
      
      if (!canAccessRegion(existingPhoto.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      const validatedData = insertWalkthroughPhotoSchema.partial().parse(req.body);
      
      if (validatedData.region && validatedData.region !== existingPhoto.region) {
        if (!canAccessRegion(validatedData.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
          return res.status(403).json({ message: "Forbidden - Cannot move to this region" });
        }
      }
      
      const photo = await storage.updateWalkthroughPhoto(req.params.id, validatedData);
      res.json(photo);
    } catch (error) {
      console.error("Error updating walkthrough photo:", error);
      res.status(500).json({ message: "Failed to update walkthrough photo" });
    }
  });

  app.delete('/api/walkthrough-photos/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageWalkthroughs) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingPhoto = await storage.getWalkthroughPhoto(req.params.id);
      if (!existingPhoto) {
        return res.status(404).json({ message: "Walkthrough photo not found" });
      }
      
      if (!canAccessRegion(existingPhoto.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      await storage.deleteWalkthroughPhoto(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting walkthrough photo:", error);
      res.status(500).json({ message: "Failed to delete walkthrough photo" });
    }
  });

  // Assets Routes
  app.get('/api/assets', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || (!permissions?.canViewAssets && !permissions?.canManageAssets)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const assets = await storage.getAllAssets();
      const allowedRegions = permissions?.allowedRegions || [];
      const isAdmin = currentUser?.role === "admin";
      const filteredAssets = isAdmin ? assets : filterByRegion(assets, allowedRegions);
      res.json(filteredAssets);
    } catch (error) {
      console.error("Error fetching assets:", error);
      res.status(500).json({ message: "Failed to fetch assets" });
    }
  });

  app.post('/api/assets', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageAssets) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const validatedData = insertAssetSchema.parse(req.body);
      
      if (validatedData.region && !canAccessRegion(validatedData.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Cannot create in this region" });
      }
      
      const asset = await storage.createAsset(validatedData);
      res.json(asset);
    } catch (error) {
      console.error("Error creating asset:", error);
      res.status(500).json({ message: "Failed to create asset" });
    }
  });

  app.patch('/api/assets/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageAssets) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingAsset = await storage.getAsset(req.params.id);
      if (!existingAsset) {
        return res.status(404).json({ message: "Asset not found" });
      }
      
      if (!canAccessRegion(existingAsset.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      const validatedData = insertAssetSchema.partial().parse(req.body);
      
      if (validatedData.region && validatedData.region !== existingAsset.region) {
        if (!canAccessRegion(validatedData.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
          return res.status(403).json({ message: "Forbidden - Cannot move to this region" });
        }
      }
      
      const asset = await storage.updateAsset(req.params.id, validatedData);
      res.json(asset);
    } catch (error) {
      console.error("Error updating asset:", error);
      res.status(500).json({ message: "Failed to update asset" });
    }
  });

  app.delete('/api/assets/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageAssets) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingAsset = await storage.getAsset(req.params.id);
      if (!existingAsset) {
        return res.status(404).json({ message: "Asset not found" });
      }
      
      if (!canAccessRegion(existingAsset.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      await storage.deleteAsset(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting asset:", error);
      res.status(500).json({ message: "Failed to delete asset" });
    }
  });

  // File Upload Route (images)
  app.post('/api/upload', isAuthenticated, upload.single('file'), async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }
      const filename = generateUploadFilename(req.file.originalname);
      await putUpload(filename, req.file.buffer);
      res.json({ url: `/uploads/${filename}`, filename });
    } catch (error) {
      console.error("Error uploading file:", error);
      res.status(500).json({ message: "Failed to upload file" });
    }
  });

  // Document Upload Route (PDF, images, doc files up to 20MB)
  const docUpload = multer({
    storage: fileStorage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const allowedTypes = /pdf|doc|docx|jpeg|jpg|png|gif|webp/;
      const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
      if (extname) {
        return cb(null, true);
      }
      cb(new Error("Only document and image files are allowed"));
    },
  });

  app.post('/api/upload-doc', isAuthenticated, docUpload.single('file'), async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }
      const filename = generateUploadFilename(req.file.originalname);
      await putUpload(filename, req.file.buffer);
      res.json({ url: `/uploads/${filename}`, filename, originalName: req.file.originalname });
    } catch (error) {
      console.error("Error uploading document:", error);
      res.status(500).json({ message: "Failed to upload document" });
    }
  });

  // Asset Photos Routes
  app.get('/api/asset-photos', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || (!permissions?.canViewAssets && !permissions?.canManageAssets)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const photos = await storage.getAllAssetPhotos();
      const assets = await storage.getAllAssets();
      const allowedRegions = permissions?.allowedRegions || [];
      const isAdmin = currentUser?.role === "admin";
      
      const filteredPhotos = isAdmin ? photos : photos.filter(photo => {
        const asset = assets.find(a => a.id === photo.assetId);
        return asset && asset.region && allowedRegions.includes(asset.region);
      });
      res.json(filteredPhotos);
    } catch (error) {
      console.error("Error fetching asset photos:", error);
      res.status(500).json({ message: "Failed to fetch asset photos" });
    }
  });

  app.get('/api/asset-photos/asset/:assetId', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || (!permissions?.canViewAssets && !permissions?.canManageAssets)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const asset = await storage.getAsset(req.params.assetId);
      if (!asset) {
        return res.status(404).json({ message: "Asset not found" });
      }
      
      const allowedRegions = permissions?.allowedRegions || [];
      const isAdmin = currentUser?.role === "admin";
      if (!isAdmin && asset.region && !allowedRegions.includes(asset.region)) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      const photos = await storage.getAssetPhotosByAsset(req.params.assetId);
      res.json(photos);
    } catch (error) {
      console.error("Error fetching asset photos:", error);
      res.status(500).json({ message: "Failed to fetch asset photos" });
    }
  });

  app.post('/api/asset-photos', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageAssets) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const validatedData = insertAssetPhotoSchema.parse(req.body);
      
      const parentAsset = await storage.getAsset(validatedData.assetId);
      if (parentAsset && !canAccessRegion(parentAsset.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Cannot create in this region" });
      }
      
      const photo = await storage.createAssetPhoto(validatedData);
      res.json(photo);
    } catch (error) {
      console.error("Error creating asset photo:", error);
      res.status(500).json({ message: "Failed to create asset photo" });
    }
  });

  app.delete('/api/asset-photos/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageAssets) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingPhoto = await storage.getAssetPhoto(req.params.id);
      if (!existingPhoto) {
        return res.status(404).json({ message: "Asset photo not found" });
      }
      
      const parentAsset = await storage.getAsset(existingPhoto.assetId);
      if (parentAsset && !canAccessRegion(parentAsset.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      await storage.deleteAssetPhoto(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting asset photo:", error);
      res.status(500).json({ message: "Failed to delete asset photo" });
    }
  });

  // Maintenance Contacts Routes
  app.get('/api/contacts', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      const isAdmin = currentUser?.role === "admin";

      if (!currentUser?.isActive || (!isAdmin && !permissions?.canViewContacts && !permissions?.canManageContacts)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const contacts = await storage.getAllMaintenanceContacts();
      const allowedRegions = permissions?.allowedRegions || [];
      const filteredContacts = isAdmin ? contacts : filterByRegion(contacts, allowedRegions);
      res.json(filteredContacts);
    } catch (error) {
      console.error("Error fetching contacts:", error);
      res.status(500).json({ message: "Failed to fetch contacts" });
    }
  });

  app.post('/api/contacts', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      const isAdmin = currentUser?.role === "admin";

      if (!currentUser?.isActive || (!isAdmin && !permissions?.canManageContacts)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const validatedData = insertMaintenanceContactSchema.parse(req.body);
      
      if (validatedData.region && !canAccessRegion(validatedData.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Cannot create in this region" });
      }
      
      const contact = await storage.createMaintenanceContact(validatedData);
      res.json(contact);
    } catch (error) {
      console.error("Error creating contact:", error);
      res.status(500).json({ message: "Failed to create contact" });
    }
  });

  app.patch('/api/contacts/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      const isAdmin = currentUser?.role === "admin";

      if (!currentUser?.isActive || (!isAdmin && !permissions?.canManageContacts)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingContact = await storage.getMaintenanceContact(req.params.id);
      if (!existingContact) {
        return res.status(404).json({ message: "Contact not found" });
      }
      
      if (!canAccessRegion(existingContact.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      const validatedData = insertMaintenanceContactSchema.partial().parse(req.body);
      
      if (validatedData.region && validatedData.region !== existingContact.region) {
        if (!canAccessRegion(validatedData.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
          return res.status(403).json({ message: "Forbidden - Cannot move to this region" });
        }
      }
      
      const contact = await storage.updateMaintenanceContact(req.params.id, validatedData);
      res.json(contact);
    } catch (error) {
      console.error("Error updating contact:", error);
      res.status(500).json({ message: "Failed to update contact" });
    }
  });

  app.delete('/api/contacts/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      const isAdmin = currentUser?.role === "admin";

      if (!currentUser?.isActive || (!isAdmin && !permissions?.canManageContacts)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingContact = await storage.getMaintenanceContact(req.params.id);
      if (!existingContact) {
        return res.status(404).json({ message: "Contact not found" });
      }
      
      if (!canAccessRegion(existingContact.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      await storage.deleteMaintenanceContact(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting contact:", error);
      res.status(500).json({ message: "Failed to delete contact" });
    }
  });

  // Invoices Routes
  app.get('/api/invoices', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || (!permissions?.canViewBilling && !permissions?.canManageBilling)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const invoices = await storage.getAllInvoices();
      const allowedRegions = permissions?.allowedRegions || [];
      const isAdmin = currentUser?.role === "admin";
      const filteredInvoices = isAdmin ? invoices : filterByRegion(invoices, allowedRegions);
      res.json(filteredInvoices);
    } catch (error) {
      console.error("Error fetching invoices:", error);
      res.status(500).json({ message: "Failed to fetch invoices" });
    }
  });

  app.post('/api/invoices', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageBilling) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const validatedData = insertInvoiceSchema.parse(req.body);
      
      if (validatedData.region && !canAccessRegion(validatedData.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Cannot create in this region" });
      }
      
      const invoice = await storage.createInvoice(validatedData);
      res.json(invoice);
    } catch (error) {
      console.error("Error creating invoice:", error);
      res.status(500).json({ message: "Failed to create invoice" });
    }
  });

  app.patch('/api/invoices/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageBilling) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingInvoice = await storage.getInvoice(req.params.id);
      if (!existingInvoice) {
        return res.status(404).json({ message: "Invoice not found" });
      }
      
      if (!canAccessRegion(existingInvoice.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      const validatedData = insertInvoiceSchema.partial().parse(req.body);
      
      if (validatedData.region && validatedData.region !== existingInvoice.region) {
        if (!canAccessRegion(validatedData.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
          return res.status(403).json({ message: "Forbidden - Cannot move to this region" });
        }
      }
      
      const invoice = await storage.updateInvoice(req.params.id, validatedData);
      res.json(invoice);
    } catch (error) {
      console.error("Error updating invoice:", error);
      res.status(500).json({ message: "Failed to update invoice" });
    }
  });

  app.delete('/api/invoices/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageBilling) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingInvoice = await storage.getInvoice(req.params.id);
      if (!existingInvoice) {
        return res.status(404).json({ message: "Invoice not found" });
      }
      
      if (!canAccessRegion(existingInvoice.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      await storage.deleteInvoice(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting invoice:", error);
      res.status(500).json({ message: "Failed to delete invoice" });
    }
  });

  // Billing Records Routes
  app.get('/api/billing', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      const isAdmin = currentUser?.role === "admin";

      if (!currentUser?.isActive || (!isAdmin && !permissions?.canViewBilling && !permissions?.canManageBilling)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const billingRecords = await storage.getAllBillingRecords();
      res.json(billingRecords);
    } catch (error) {
      console.error("Error fetching billing records:", error);
      res.status(500).json({ message: "Failed to fetch billing records" });
    }
  });

  app.post('/api/billing', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      const isAdmin = currentUser?.role === "admin";

      if (!currentUser?.isActive || (!isAdmin && !permissions?.canManageBilling)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const { createContact, ...rest } = req.body;
      const validatedData = insertBillingRecordSchema.parse(rest);

      // If createContact is true and no contactId, create a new contact from the billing info
      if (createContact && !validatedData.contactId) {
        const newContact = await storage.createMaintenanceContact({
          name: validatedData.companyName,
          company: validatedData.companyName,
          service: "",
          phone: validatedData.phone,
          email: validatedData.email,
          region: "",
          buildingAddress: "",
        });
        (validatedData as any).contactId = newContact.id;
      }

      const record = await storage.createBillingRecord(validatedData);
      res.json(record);
    } catch (error) {
      console.error("Error creating billing record:", error);
      res.status(500).json({ message: "Failed to create billing record" });
    }
  });

  app.patch('/api/billing/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      const isAdmin = currentUser?.role === "admin";

      if (!currentUser?.isActive || (!isAdmin && !permissions?.canManageBilling)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingRecord = await storage.getBillingRecord(req.params.id);
      if (!existingRecord) {
        return res.status(404).json({ message: "Billing record not found" });
      }

      const validatedData = insertBillingRecordSchema.partial().parse(req.body);
      const record = await storage.updateBillingRecord(req.params.id, validatedData);
      res.json(record);
    } catch (error) {
      console.error("Error updating billing record:", error);
      res.status(500).json({ message: "Failed to update billing record" });
    }
  });

  app.delete('/api/billing/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      const isAdmin = currentUser?.role === "admin";

      if (!currentUser?.isActive || (!isAdmin && !permissions?.canManageBilling)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingRecord = await storage.getBillingRecord(req.params.id);
      if (!existingRecord) {
        return res.status(404).json({ message: "Billing record not found" });
      }

      await storage.deleteBillingRecord(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting billing record:", error);
      res.status(500).json({ message: "Failed to delete billing record" });
    }
  });

  // Properties Routes
  app.get('/api/properties', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      const isAdmin = currentUser?.role === "admin";
      
      if (!currentUser?.isActive || (!isAdmin && !permissions?.canViewProperties && !permissions?.canManageProperties)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const properties = await storage.getAllProperties();
      const allowedRegions = permissions?.allowedRegions || [];
      const filteredProperties = isAdmin ? properties : filterByRegion(properties, allowedRegions);
      res.json(filteredProperties);
    } catch (error) {
      console.error("Error fetching properties:", error);
      res.status(500).json({ message: "Failed to fetch properties" });
    }
  });

  app.post('/api/properties', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      const isAdmin = currentUser?.role === "admin";
      
      if (!currentUser?.isActive || (!isAdmin && !permissions?.canManageProperties)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const validatedData = insertPropertySchema.parse(req.body);
      
      if (validatedData.region && !canAccessRegion(validatedData.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Cannot create in this region" });
      }
      
      // Compute full address from components
      const address = `${validatedData.streetAddress}, ${validatedData.city}, ${validatedData.state} ${validatedData.zipCode}`;
      const property = await storage.createProperty({ ...validatedData, address });
      res.json(property);
    } catch (error: any) {
      console.error("Error creating property:", error);
      if (error.name === 'ZodError') {
        return res.status(400).json({ message: "Validation error", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to create property", error: error.message });
    }
  });

  app.patch('/api/properties/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      const isAdmin = currentUser?.role === "admin";
      
      if (!currentUser?.isActive || (!isAdmin && !permissions?.canManageProperties)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingProperty = await storage.getProperty(req.params.id);
      if (!existingProperty) {
        return res.status(404).json({ message: "Property not found" });
      }
      
      if (!canAccessRegion(existingProperty.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      const validatedData = insertPropertySchema.partial().parse(req.body);
      
      if (validatedData.region && validatedData.region !== existingProperty.region) {
        if (!canAccessRegion(validatedData.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
          return res.status(403).json({ message: "Forbidden - Cannot move to this region" });
        }
      }
      
      // If address components are being updated, recompute the full address
      let updateData: Partial<InsertPropertyWithAddress> = { ...validatedData };
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
      console.error("Error updating property:", error);
      res.status(500).json({ message: "Failed to update property" });
    }
  });

  app.delete('/api/properties/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      const isAdmin = currentUser?.role === "admin";
      
      if (!currentUser?.isActive || (!isAdmin && !permissions?.canManageProperties)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingProperty = await storage.getProperty(req.params.id);
      if (!existingProperty) {
        return res.status(404).json({ message: "Property not found" });
      }
      
      if (!canAccessRegion(existingProperty.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      await storage.deleteProperty(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting property:", error);
      res.status(500).json({ message: "Failed to delete property" });
    }
  });

  // ─── Uploaded files ────────────────────────────────────────────────────────
  // Requires a valid session. These files include maintenance and walkthrough
  // photos as well as W-9s, COIs and contract invoices, so they must never be
  // downloadable by an anonymous visitor who guesses a filename.
  app.get('/uploads/:filename', isAuthenticated, async (req, res) => {
    const requested = req.params.filename;

    // Reject anything that is not a bare filename, so a crafted key cannot
    // reach outside the uploads prefix in the bucket.
    if (!requested || requested !== path.basename(requested) || requested.startsWith(".")) {
      return res.status(400).json({ message: "Invalid filename" });
    }

    try {
      if (!(await uploadExists(requested))) {
        return res.status(404).json({ message: "File not found" });
      }
    } catch (error) {
      console.error("Error checking uploaded file:", error);
      return res.status(500).json({ message: "Failed to load file" });
    }

    // "private" keeps authenticated content out of shared/proxy caches.
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Type", contentTypeFor(requested));

    const stream = openUploadStream(requested);

    // If the client disconnects part way through, stop pulling bytes out of
    // the bucket instead of leaving the download running.
    res.on("close", () => stream.destroy());

    stream.on("error", (error) => {
      console.error("Error streaming uploaded file:", error);
      // Detach first, so no further bytes can race the response below.
      stream.unpipe(res);
      if (res.headersSent) {
        // Part of the file has already gone out, so the only honest signal
        // left is to break the connection rather than end it normally and
        // let the client treat a truncated file as complete.
        res.destroy();
      } else {
        res.status(500).json({ message: "Failed to load file" });
      }
    });

    stream.pipe(res);
  });

  // ─── JotForm Webhook ───────────────────────────────────────────────────────
  // Called by JotForm's servers, so it cannot use session auth. It is guarded
  // by a shared secret instead, passed as ?secret=... on the webhook URL.
  // Configure in JotForm: Settings → Integrations → WebHooks → add this URL
  app.post('/api/webhooks/jotform', async (req, res) => {
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
        mondayItemId: null,
      });

      // Async Monday.com sync (non-blocking)
      createMondayItem({
        title: request.title,
        description: request.description,
        category: request.category,
        priority: request.priority,
        status: request.status,
        region: request.region,
        buildingAddress: request.buildingAddress,
        location: request.location,
        submittedBy: request.submittedBy,
      }).then(async (mondayItemId) => {
        if (mondayItemId) {
          await storage.updateMaintenanceRequest(request.id, { mondayItemId });
        }
      }).catch((err) => console.error('[JotForm] Monday.com sync failed:', err));

      console.log(`[JotForm] Created maintenance request ${request.id}: "${title}" (${priority} priority)`);
      res.status(200).json({ success: true, id: request.id });
    } catch (error) {
      console.error('[JotForm] Webhook processing error:', error);
      res.status(500).json({ message: 'Failed to process JotForm submission' });
    }
  });

  // Return current webhook config info (admin + regional_administrator)
  app.get('/api/webhooks/jotform/config', isAuthenticated, async (req: any, res) => {
    try {
      const currentUser = await storage.getUser(getUserId(req));
      if (currentUser?.role !== 'admin' && currentUser?.role !== 'regional_administrator') {
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
      res.status(500).json({ message: 'Failed to get config' });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

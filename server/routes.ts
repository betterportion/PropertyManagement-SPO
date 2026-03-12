import type { Express } from "express";
import { createServer, type Server } from "http";
import express from "express";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./replitAuth";
import { z } from "zod";
import multer from "multer";
import { createMondayItem, updateMondayItem } from "./monday";
import path from "path";
import fs from "fs";
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

const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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

  // Walkthrough Rooms Routes
  app.get('/api/walkthrough-rooms', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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

  // File Upload Route
  app.post('/api/upload', isAuthenticated, upload.single('file'), async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }
      const fileUrl = `/uploads/${req.file.filename}`;
      res.json({ url: fileUrl, filename: req.file.filename });
    } catch (error) {
      console.error("Error uploading file:", error);
      res.status(500).json({ message: "Failed to upload file" });
    }
  });

  // Asset Photos Routes
  app.get('/api/asset-photos', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || (!permissions?.canViewContacts && !permissions?.canManageContacts)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const contacts = await storage.getAllMaintenanceContacts();
      const allowedRegions = permissions?.allowedRegions || [];
      const isAdmin = currentUser?.role === "admin";
      const filteredContacts = isAdmin ? contacts : filterByRegion(contacts, allowedRegions);
      res.json(filteredContacts);
    } catch (error) {
      console.error("Error fetching contacts:", error);
      res.status(500).json({ message: "Failed to fetch contacts" });
    }
  });

  app.post('/api/contacts', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageContacts) {
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
      const userId = req.user.claims.sub;
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageContacts) {
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
      const userId = req.user.claims.sub;
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageContacts) {
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || (!permissions?.canViewBilling && !permissions?.canManageBilling)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const billingRecords = await storage.getAllBillingRecords();
      const allowedRegions = permissions?.allowedRegions || [];
      const isAdmin = currentUser?.role === "admin";
      const filteredRecords = isAdmin ? billingRecords : filterByRegion(billingRecords, allowedRegions);
      res.json(filteredRecords);
    } catch (error) {
      console.error("Error fetching billing records:", error);
      res.status(500).json({ message: "Failed to fetch billing records" });
    }
  });

  app.post('/api/billing', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageBilling) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const validatedData = insertBillingRecordSchema.parse(req.body);
      
      if (validatedData.region && !canAccessRegion(validatedData.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Cannot create in this region" });
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
      const userId = req.user.claims.sub;
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageBilling) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingRecord = await storage.getBillingRecord(req.params.id);
      if (!existingRecord) {
        return res.status(404).json({ message: "Billing record not found" });
      }
      
      if (!canAccessRegion(existingRecord.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
      }

      const validatedData = insertBillingRecordSchema.partial().parse(req.body);
      
      if (validatedData.region && validatedData.region !== existingRecord.region) {
        if (!canAccessRegion(validatedData.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
          return res.status(403).json({ message: "Forbidden - Cannot move to this region" });
        }
      }
      
      const record = await storage.updateBillingRecord(req.params.id, validatedData);
      res.json(record);
    } catch (error) {
      console.error("Error updating billing record:", error);
      res.status(500).json({ message: "Failed to update billing record" });
    }
  });

  app.delete('/api/billing/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageBilling) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const existingRecord = await storage.getBillingRecord(req.params.id);
      if (!existingRecord) {
        return res.status(404).json({ message: "Billing record not found" });
      }
      
      if (!canAccessRegion(existingRecord.region, permissions?.allowedRegions || [], currentUser?.role === "admin")) {
        return res.status(403).json({ message: "Forbidden - Region not accessible" });
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
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

  // Serve uploaded files
  app.use('/uploads', express.static(uploadDir));

  const httpServer = createServer(app);
  return httpServer;
}

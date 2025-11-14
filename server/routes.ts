import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./replitAuth";
import {
  insertMaintenanceRequestSchema,
  insertWalkthroughRoomSchema,
  insertWalkthroughPhotoSchema,
  insertAssetSchema,
  insertMaintenanceContactSchema,
  insertInvoiceSchema,
  insertBillingRecordSchema,
} from "@shared/schema";

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
      const { role } = req.body;
      const user = await storage.updateUserRole(req.params.id, role);
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

  app.patch('/api/users/:id/permissions', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const currentUser = await storage.getUser(userId);
      if (currentUser?.role !== "admin") {
        return res.status(403).json({ message: "Forbidden" });
      }
      const permissions = await storage.upsertUserPermissions({
        userId: req.params.id,
        ...req.body,
      });
      res.json(permissions);
    } catch (error) {
      console.error("Error updating permissions:", error);
      res.status(500).json({ message: "Failed to update permissions" });
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
  app.get('/api/maintenance', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || (!permissions?.canViewMaintenance && !permissions?.canManageMaintenance)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const requests = await storage.getAllMaintenanceRequests();
      res.json(requests);
    } catch (error) {
      console.error("Error fetching maintenance requests:", error);
      res.status(500).json({ message: "Failed to fetch maintenance requests" });
    }
  });

  app.get('/api/maintenance/:id', isAuthenticated, async (req: any, res) => {
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
      res.json(request);
    } catch (error) {
      console.error("Error fetching maintenance request:", error);
      res.status(500).json({ message: "Failed to fetch maintenance request" });
    }
  });

  app.post('/api/maintenance', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || (!permissions?.canViewMaintenance && !permissions?.canManageMaintenance)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const validatedData = insertMaintenanceRequestSchema.parse(req.body);
      const request = await storage.createMaintenanceRequest({
        ...validatedData,
        submittedBy: currentUser.email || "Unknown",
      });
      res.json(request);
    } catch (error) {
      console.error("Error creating maintenance request:", error);
      res.status(500).json({ message: "Failed to create maintenance request" });
    }
  });

  app.patch('/api/maintenance/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageMaintenance) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const validatedData = insertMaintenanceRequestSchema.partial().parse(req.body);
      const request = await storage.updateMaintenanceRequest(req.params.id, validatedData);
      res.json(request);
    } catch (error) {
      console.error("Error updating maintenance request:", error);
      res.status(500).json({ message: "Failed to update maintenance request" });
    }
  });

  app.delete('/api/maintenance/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageMaintenance) {
        return res.status(403).json({ message: "Forbidden" });
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
      res.json(rooms);
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

      const validatedData = insertWalkthroughRoomSchema.partial().parse(req.body);
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
      res.json(photos);
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
      res.json(photos);
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

      const validatedData = insertWalkthroughPhotoSchema.partial().parse(req.body);
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
      res.json(assets);
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

      const validatedData = insertAssetSchema.partial().parse(req.body);
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

      await storage.deleteAsset(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting asset:", error);
      res.status(500).json({ message: "Failed to delete asset" });
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
      res.json(contacts);
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

      const validatedData = insertMaintenanceContactSchema.partial().parse(req.body);
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
      
      if (!currentUser?.isActive || (!permissions?.canViewContacts && !permissions?.canManageContacts)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const invoices = await storage.getAllInvoices();
      res.json(invoices);
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
      
      if (!currentUser?.isActive || !permissions?.canManageContacts) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const validatedData = insertInvoiceSchema.parse(req.body);
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
      
      if (!currentUser?.isActive || !permissions?.canManageContacts) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const validatedData = insertInvoiceSchema.partial().parse(req.body);
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
      
      if (!currentUser?.isActive || !permissions?.canManageContacts) {
        return res.status(403).json({ message: "Forbidden" });
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
      res.json(billingRecords);
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
      const userId = req.user.claims.sub;
      const currentUser = await storage.getUser(userId);
      const permissions = await storage.getUserPermissions(userId);
      
      if (!currentUser?.isActive || !permissions?.canManageBilling) {
        return res.status(403).json({ message: "Forbidden" });
      }

      await storage.deleteBillingRecord(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting billing record:", error);
      res.status(500).json({ message: "Failed to delete billing record" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Search, UserCog, Shield, AlertCircle, Plus, MapPin, Eye, Settings2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertUserSchema, type User, type UserPermissions } from "@shared/schema";
import { z } from "zod";

const ALL_REGIONS = [
  { id: "west-central", name: "West Central" },
  { id: "east-central", name: "East Central" },
  { id: "north-west", name: "North West" },
  { id: "south-west", name: "South West" },
  { id: "north-east", name: "North East" },
  { id: "south-east", name: "South East" },
];

const FEATURE_PERMISSIONS = [
  { key: "canViewMaintenance", label: "View Maintenance", section: "Maintenance" },
  { key: "canManageMaintenance", label: "Manage Maintenance", section: "Maintenance" },
  { key: "canViewWalkthroughs", label: "View Walkthroughs", section: "Walkthroughs" },
  { key: "canManageWalkthroughs", label: "Manage Walkthroughs", section: "Walkthroughs" },
  { key: "canViewAssets", label: "View Assets", section: "Assets" },
  { key: "canManageAssets", label: "Manage Assets", section: "Assets" },
  { key: "canViewProperties", label: "View Properties", section: "Properties" },
  { key: "canManageProperties", label: "Manage Properties", section: "Properties" },
  { key: "canViewBilling", label: "View Invoices", section: "Invoices" },
  { key: "canManageBilling", label: "Manage Invoices", section: "Invoices" },
  { key: "canViewContacts", label: "View Contacts", section: "Contacts" },
  { key: "canManageContacts", label: "Manage Contacts", section: "Contacts" },
  { key: "canManageUsers", label: "Manage Users", section: "Administration" },
] as const;

export default function Settings() {
  const [searchQuery, setSearchQuery] = useState("");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isPermissionsDialogOpen, setIsPermissionsDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [editingPermissions, setEditingPermissions] = useState<Partial<UserPermissions>>({});
  const { toast } = useToast();
  const { user: currentUser } = useAuth();

  const { data: users, isLoading } = useQuery({
    queryKey: ["/api/users"],
  });

  const { data: userPermissionsData } = useQuery<UserPermissions>({
    queryKey: ["/api/users", selectedUser?.id, "permissions"],
    enabled: !!selectedUser,
  });

  useEffect(() => {
    if (userPermissionsData) {
      setEditingPermissions({
        ...userPermissionsData,
        allowedRegions: userPermissionsData.allowedRegions || [],
      });
    }
  }, [userPermissionsData]);

  const updatePermissionsMutation = useMutation({
    mutationFn: async (permissions: Partial<UserPermissions>) => {
      await apiRequest("PATCH", `/api/users/${selectedUser?.id}/permissions`, permissions);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users", selectedUser?.id, "permissions"] });
      setIsPermissionsDialogOpen(false);
      setSelectedUser(null);
      toast({
        title: "Success",
        description: "User permissions updated successfully",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update user permissions",
        variant: "destructive",
      });
    },
  });

  const handleOpenPermissions = (user: User) => {
    setSelectedUser(user);
    setIsPermissionsDialogOpen(true);
  };

  const handleToggleFeaturePermission = (key: string, checked: boolean) => {
    setEditingPermissions(prev => ({
      ...prev,
      [key]: checked,
    }));
  };

  const handleToggleRegion = (regionId: string, checked: boolean) => {
    setEditingPermissions(prev => {
      const currentRegions = prev.allowedRegions || [];
      const newRegions = checked
        ? [...currentRegions, regionId]
        : currentRegions.filter(r => r !== regionId);
      return { ...prev, allowedRegions: newRegions };
    });
  };

  const handleSelectAllRegions = () => {
    setEditingPermissions(prev => ({
      ...prev,
      allowedRegions: ALL_REGIONS.map(r => r.id),
    }));
  };

  const handleClearAllRegions = () => {
    setEditingPermissions(prev => ({
      ...prev,
      allowedRegions: [],
    }));
  };

  const handleSavePermissions = () => {
    if (selectedUser) {
      updatePermissionsMutation.mutate(editingPermissions);
    }
  };

  if ((currentUser as any)?.role !== "admin") {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-2xl font-semibold mb-2">Access Denied</h2>
        <p className="text-muted-foreground">You do not have permission to access this page.</p>
      </div>
    );
  }

  const updateRoleMutation = useMutation({
    mutationFn: async ({ id, role }: { id: string; role: "admin" | "regional_administrator" | "resident" }) => {
      await apiRequest("PATCH", `/api/users/${id}/role`, { role });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/users"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] })
      ]);
      toast({
        title: "Success",
        description: "User role updated successfully",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update user role",
        variant: "destructive",
      });
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      await apiRequest("PATCH", `/api/users/${id}/status`, { isActive });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({
        title: "Success",
        description: "User status updated successfully",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update user status",
        variant: "destructive",
      });
    },
  });

  const createUserMutation = useMutation({
    mutationFn: async (data: z.infer<typeof insertUserSchema>) => {
      return await apiRequest("POST", "/api/users", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setIsAddDialogOpen(false);
      form.reset();
      toast({
        title: "Success",
        description: "User created successfully",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create user",
        variant: "destructive",
      });
    },
  });

  const form = useForm<z.infer<typeof insertUserSchema>>({
    resolver: zodResolver(insertUserSchema),
    defaultValues: {
      email: "",
      firstName: "",
      lastName: "",
      role: "resident",
      isActive: true,
    },
  });

  const filteredUsers = (users as User[] || []).filter((user) =>
    user.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.firstName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.lastName?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">User Management</h1>
        <p className="text-muted-foreground mt-1">
          Manage user accounts, roles, and permissions
        </p>
      </div>

      <div className="flex gap-4 items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search users..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
            data-testid="input-search-users"
          />
        </div>

        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-user">
              <Plus className="h-4 w-4 mr-2" />
              Add User
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New User</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit((data) => createUserMutation.mutate(data))} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="firstName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>First Name</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ""} data-testid="input-first-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="lastName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Last Name</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ""} data-testid="input-last-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value || ""} type="email" data-testid="input-email" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="role"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Role</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-role">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="regional_administrator">Regional Admin</SelectItem>
                          <SelectItem value="resident">Resident</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createUserMutation.isPending} data-testid="button-submit-user">
                    {createUserMutation.isPending ? "Creating..." : "Create User"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8">
                  Loading users...
                </TableCell>
              </TableRow>
            ) : filteredUsers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  No users found
                </TableCell>
              </TableRow>
            ) : (
              filteredUsers.map((user) => (
                <TableRow key={user.id} data-testid={`row-user-${user.id}`}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      {user.profileImageUrl && (
                        <img
                          src={user.profileImageUrl}
                          alt={`${user.firstName} ${user.lastName}`}
                          className="h-8 w-8 rounded-full object-cover"
                        />
                      )}
                      <div>
                        <div className="font-medium">
                          {user.firstName} {user.lastName}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>{user.email || "—"}</TableCell>
                  <TableCell>
                    <Select
                      value={user.role}
                      onValueChange={(value) =>
                        updateRoleMutation.mutate({ id: user.id, role: value as "admin" | "regional_administrator" | "resident" })
                      }
                      disabled={updateRoleMutation.isPending}
                    >
                      <SelectTrigger className="w-32" data-testid={`select-role-${user.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">
                          <div className="flex items-center gap-2">
                            <Shield className="h-3 w-3" />
                            Admin
                          </div>
                        </SelectItem>
                        <SelectItem value="regional_administrator">
                          <div className="flex items-center gap-2">
                            <UserCog className="h-3 w-3" />
                            Regional Admin
                          </div>
                        </SelectItem>
                        <SelectItem value="resident">
                          <div className="flex items-center gap-2">
                            <UserCog className="h-3 w-3" />
                            Resident
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={user.isActive}
                        onCheckedChange={(checked) =>
                          updateStatusMutation.mutate({ id: user.id, isActive: checked })
                        }
                        disabled={updateStatusMutation.isPending}
                        data-testid={`switch-status-${user.id}`}
                      />
                      <Badge variant={user.isActive ? "default" : "secondary"}>
                        {user.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleOpenPermissions(user)}
                      data-testid={`button-permissions-${user.id}`}
                    >
                      <Settings2 className="h-4 w-4 mr-2" />
                      Permissions
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={isPermissionsDialogOpen} onOpenChange={(open) => {
        setIsPermissionsDialogOpen(open);
        if (!open) setSelectedUser(null);
      }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Permissions for {selectedUser?.firstName} {selectedUser?.lastName}
            </DialogTitle>
            <DialogDescription>
              Configure what this user can access and which regions they can manage.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <MapPin className="h-4 w-4" />
                  Region Access
                </h3>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleSelectAllRegions}>
                    Select All
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleClearAllRegions}>
                    Clear All
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Select which regions this user can view and manage data for.
              </p>
              <div className="grid grid-cols-2 gap-3">
                {ALL_REGIONS.map((region) => (
                  <div
                    key={region.id}
                    className="flex items-center space-x-2 p-3 border rounded-md hover-elevate"
                  >
                    <Checkbox
                      id={`region-${region.id}`}
                      checked={(editingPermissions.allowedRegions || []).includes(region.id)}
                      onCheckedChange={(checked) => handleToggleRegion(region.id, !!checked)}
                      data-testid={`checkbox-region-${region.id}`}
                    />
                    <Label htmlFor={`region-${region.id}`} className="cursor-pointer flex-1">
                      {region.name}
                    </Label>
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
                <Eye className="h-4 w-4" />
                Feature Permissions
              </h3>
              <p className="text-xs text-muted-foreground mb-3">
                Control which features this user can access and manage.
              </p>
              <div className="space-y-4">
                {Object.entries(
                  FEATURE_PERMISSIONS.reduce((acc, perm) => {
                    if (!acc[perm.section]) acc[perm.section] = [];
                    acc[perm.section].push(perm);
                    return acc;
                  }, {} as Record<string, typeof FEATURE_PERMISSIONS[number][]>)
                ).map(([section, permissions]) => (
                  <div key={section}>
                    <h4 className="text-xs font-medium text-muted-foreground uppercase mb-2">{section}</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {permissions.map((perm) => (
                        <div
                          key={perm.key}
                          className="flex items-center space-x-2 p-2 border rounded-md"
                        >
                          <Checkbox
                            id={`perm-${perm.key}`}
                            checked={!!editingPermissions[perm.key as keyof UserPermissions]}
                            onCheckedChange={(checked) => handleToggleFeaturePermission(perm.key, !!checked)}
                            data-testid={`checkbox-${perm.key}`}
                          />
                          <Label htmlFor={`perm-${perm.key}`} className="cursor-pointer flex-1 text-sm">
                            {perm.label}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsPermissionsDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSavePermissions}
              disabled={updatePermissionsMutation.isPending}
              data-testid="button-save-permissions"
            >
              {updatePermissionsMutation.isPending ? "Saving..." : "Save Permissions"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

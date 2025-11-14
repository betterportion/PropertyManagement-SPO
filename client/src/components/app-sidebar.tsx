import { Home, Wrench, Camera, Package, DollarSign, Users, Building2 } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";

interface AppSidebarProps {
  role: "admin" | "resident";
  currentPath: string;
}

const adminMenuItems = [
  {
    title: "Dashboard",
    url: "/",
    icon: Home,
  },
  {
    title: "Maintenance",
    url: "/maintenance",
    icon: Wrench,
  },
  {
    title: "Walkthroughs",
    url: "/walkthroughs",
    icon: Camera,
  },
  {
    title: "Assets",
    url: "/assets",
    icon: Package,
  },
  {
    title: "Billing",
    url: "/billing",
    icon: DollarSign,
  },
  {
    title: "Contacts",
    url: "/contacts",
    icon: Users,
  },
];

const residentMenuItems = [
  {
    title: "Dashboard",
    url: "/",
    icon: Home,
  },
  {
    title: "Submit Request",
    url: "/submit-request",
    icon: Wrench,
  },
  {
    title: "My Requests",
    url: "/my-requests",
    icon: Wrench,
  },
];

export function AppSidebar({ role, currentPath }: AppSidebarProps) {
  const menuItems = role === "admin" ? adminMenuItems : residentMenuItems;

  return (
    <Sidebar>
      <SidebarHeader className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="flex-shrink-0">
            <div className="p-2 bg-primary rounded-md">
              <Building2 className="h-5 w-5 text-primary-foreground" />
            </div>
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-sm leading-tight">SPO Property Management Portal</h2>
            <p className="text-xs text-muted-foreground">Saint Paul's Outreach, Inc.</p>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map((item) => {
                const isActive = currentPath === item.url;
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton 
                      asChild 
                      className={isActive ? "bg-sidebar-accent" : ""}
                      data-testid={`link-${item.title.toLowerCase().replace(/\s/g, "-")}`}
                    >
                      <a href={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <div className="mt-auto p-4 border-t border-sidebar-border">
          <Badge variant="secondary" className="w-full justify-center">
            {role === "admin" ? "Admin Account" : "Resident Account"}
          </Badge>
        </div>
      </SidebarContent>
    </Sidebar>
  );
}

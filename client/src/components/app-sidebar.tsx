import { Home, Wrench, Camera, Package, DollarSign, Users, Settings, Building2 } from "lucide-react";
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
import spoLogo from "@assets/SPO Logo under 600x600px_SPO Vertical - Ocean_1763138801065.png";

interface AppSidebarProps {
  role: "admin" | "regional_administrator" | "resident";
  currentPath: string;
}

const adminMenuItems = [
  {
    title: "Dashboard",
    url: "/",
    icon: Home,
  },
  {
    title: "Properties",
    url: "/properties",
    icon: Building2,
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
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
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
  let menuItems = (role === "admin" || role === "regional_administrator") ? adminMenuItems : residentMenuItems;
  
  // Regional administrators cannot access Settings
  if (role === "regional_administrator") {
    menuItems = menuItems.filter(item => item.title !== "Settings");
  }

  return (
    <Sidebar>
      <SidebarHeader className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="flex-shrink-0">
            <img src={spoLogo} alt="SPO Logo" className="h-10 w-10 object-contain" />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-sm leading-tight">Property Management Portal</h2>
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
            {role === "admin" ? "Admin Account" : role === "regional_administrator" ? "Regional Admin" : "Resident Account"}
          </Badge>
        </div>
      </SidebarContent>
    </Sidebar>
  );
}

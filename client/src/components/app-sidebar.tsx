import { Home, Wrench, Camera, Package, Users, UsersRound, Banknote, Settings, Building2, Palette, ShieldCheck } from "lucide-react";
import { Link } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import spoLogo from "@assets/SPO Logo under 600x600px_SPO Vertical - Ocean_1763138801065.png";

interface AppSidebarProps {
  role: "admin" | "regional_administrator" | "resident";
  currentPath: string;
}

type NavItem = { title: string; url: string; icon: typeof Home };

const adminMenuItems: NavItem[] = [
  { title: "Dashboard", url: "/", icon: Home },
  { title: "Properties", url: "/properties", icon: Building2 },
  { title: "Residents", url: "/residents", icon: UsersRound },
  { title: "Finances", url: "/finances", icon: Banknote },
  { title: "Maintenance", url: "/maintenance", icon: Wrench },
  { title: "Safety", url: "/safety", icon: ShieldCheck },
  { title: "Maint Contacts & Invoices", url: "/contacts", icon: Users },
  { title: "Walkthroughs", url: "/walkthroughs", icon: Camera },
  { title: "Assets", url: "/assets", icon: Package },
];

const residentMenuItems: NavItem[] = [
  { title: "Dashboard", url: "/", icon: Home },
  { title: "Submit Request", url: "/submit-request", icon: Wrench },
  { title: "My Requests", url: "/my-requests", icon: Wrench },
];

export function AppSidebar({ role, currentPath }: AppSidebarProps) {
  const { isMobile, setOpenMobile } = useSidebar();
  const isStaff = role === "admin" || role === "regional_administrator";

  const menuItems = isStaff ? adminMenuItems : residentMenuItems;

  // Bottom-pinned utility group. Regional administrators cannot access Settings.
  const utilityItems: NavItem[] = [];
  if (role === "admin") {
    utilityItems.push({ title: "Settings", url: "/settings", icon: Settings });
  }
  if (isStaff) {
    utilityItems.push({ title: "Style guide", url: "/styleguide", icon: Palette });
  }

  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  const renderItem = (item: NavItem) => (
    <SidebarMenuItem key={item.title}>
      <SidebarMenuButton
        asChild
        isActive={currentPath === item.url}
        data-testid={`link-${item.title.toLowerCase().replace(/\s/g, "-")}`}
      >
        <Link href={item.url} onClick={closeOnMobile}>
          <item.icon />
          <span>{item.title}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );

  return (
    <Sidebar>
      <SidebarHeader className="h-16 justify-center border-b border-sidebar-border px-4 py-0">
        <Link
          href="/"
          className="flex items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="link-sidebar-home"
        >
          <img src={spoLogo} alt="SPO logo" className="h-9 w-9 shrink-0 object-contain" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold leading-tight">Property Management Portal</h2>
            <p className="truncate text-xs text-muted-foreground">Saint Paul's Outreach, Inc.</p>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{menuItems.map(renderItem)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-3 border-t border-sidebar-border">
        {utilityItems.length > 0 && <SidebarMenu>{utilityItems.map(renderItem)}</SidebarMenu>}
        <Badge variant="secondary" className="w-full justify-center py-1">
          {role === "admin"
            ? "Admin account"
            : role === "regional_administrator"
              ? "Regional admin"
              : "Resident account"}
        </Badge>
      </SidebarFooter>
    </Sidebar>
  );
}

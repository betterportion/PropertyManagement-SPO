import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import ThemeToggle from "@/components/ThemeToggle";
import UserMenu from "@/components/UserMenu";
import { ThemeProvider } from "@/providers/ThemeProvider";
import { useAuth } from "@/hooks/useAuth";
import { canFillInWalkthroughs, type WalkthroughUser } from "@/lib/walkthrough";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/Landing";
import AdminDashboard from "@/pages/AdminDashboard";
import Maintenance from "@/pages/Maintenance";
import Walkthroughs from "@/pages/Walkthroughs";
import FlaggedItems from "@/pages/FlaggedItems";
import WalkthroughRun from "@/pages/WalkthroughRun";
import Assets from "@/pages/Assets";
import AssetDetail from "@/pages/AssetDetail";
import AssignedAssets from "@/pages/AssignedAssets";
import Safety from "@/pages/Safety";
import Residents from "@/pages/Residents";
import ResidentDetail from "@/pages/ResidentDetail";
import Finances from "@/pages/Finances";
import Tasks from "@/pages/Tasks";
import Contacts from "@/pages/Contacts";
import ContactDetail from "@/pages/ContactDetail";
import Properties from "@/pages/Properties";
import PropertyDetail from "@/pages/PropertyDetail";
import MyWalkthroughs from "@/pages/MyWalkthroughs";
import ResidentDashboard from "@/pages/ResidentDashboard";
import ResourceHub from "@/pages/ResourceHub";
import SubmitRequest from "@/pages/SubmitRequest";
import MyRequests from "@/pages/MyRequests";
import AdminSettings from "@/pages/Settings";
import Styleguide from "@/pages/Styleguide";

function Router() {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (isLoading || !isAuthenticated) {
    return (
      <Switch>
        <Route path="/" component={Landing} />
        <Route component={Landing} />
      </Switch>
    );
  }

  const role = (user as any)?.role || "resident";

  if (role === "admin" || role === "regional_administrator") {
    return (
      <Switch>
        <Route path="/" component={AdminDashboard} />
        <Route path="/tasks" component={Tasks} />
        <Route path="/properties" component={Properties} />
        <Route path="/properties/:id" component={PropertyDetail} />
        <Route path="/residents" component={Residents} />
        <Route path="/residents/:id" component={ResidentDetail} />
        <Route path="/finances" component={Finances} />
        <Route path="/maintenance" component={Maintenance} />
        <Route path="/walkthroughs" component={Walkthroughs} />
        {/* Literal path first: wouter matches in order, so :id would swallow it. */}
        <Route path="/walkthroughs/flagged" component={FlaggedItems} />
        <Route path="/walkthroughs/:id" component={WalkthroughRun} />
        <Route path="/assets" component={Assets} />
        {/* Literal path first: wouter matches in order, so :id would swallow it. */}
        <Route path="/assets/assigned" component={AssignedAssets} />
        <Route path="/assets/:id" component={AssetDetail} />
        <Route path="/safety" component={Safety} />
        <Route path="/contacts" component={Contacts} />
        <Route path="/contacts/:id" component={ContactDetail} />
        <Route path="/resources" component={ResourceHub} />
        <Route path="/settings" component={AdminSettings} />
        {/* Internal design reference — staff only; residents fall through to Not Found. */}
        <Route path="/styleguide" component={Styleguide} />
        <Route component={NotFound} />
      </Switch>
    );
  }

  // A household leader or steward reaches the walkthrough screens too, behind
  // the same flag the server checks. The routes are registered either way and
  // the server binds them to their own house -- this only decides whether the
  // pages are reachable from the app at all.
  const canCompleteWalkthroughs = canFillInWalkthroughs(user as WalkthroughUser | null);

  return (
    <Switch>
      <Route path="/" component={ResidentDashboard} />
      <Route path="/submit-request" component={SubmitRequest} />
      <Route path="/my-requests" component={MyRequests} />
      {/* The one page a household leader or steward needs to go to. Open to
          every resident account: nothing on it is scoped narrower than their
          own house, and the server decides what that is. */}
      <Route path="/resources" component={ResourceHub} />
      {canCompleteWalkthroughs && <Route path="/walkthroughs" component={MyWalkthroughs} />}
      {canCompleteWalkthroughs && <Route path="/walkthroughs/:id" component={WalkthroughRun} />}
      <Route component={NotFound} />
    </Switch>
  );
}

type UserMenuUser = {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
} | null;

function AppContent() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const [location] = useLocation();

  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  if (isLoading || !isAuthenticated) {
    return (
      <div className="min-h-screen">
        <Router />
      </div>
    );
  }

  const role = (user as any)?.role || "resident";
  const canCompleteWalkthroughs = canFillInWalkthroughs(user as WalkthroughUser | null);

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full overflow-hidden bg-background">
        <AppSidebar
          role={role}
          currentPath={location}
          canCompleteWalkthroughs={canCompleteWalkthroughs}
        />
        <div className="flex flex-1 flex-col overflow-hidden">
          <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-background px-4 lg:px-6">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <UserMenu user={user as UserMenuUser} />
            </div>
          </header>
          <main className="flex-1 overflow-y-auto">
            {/* Scoped to the page body so one broken page leaves the sidebar
                and header working -- the user can navigate away instead of
                being stuck. Keyed on the route so it clears when they do. */}
            <ErrorBoundary variant="inline" resetKey={location}>
              <Router />
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <AppContent />
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

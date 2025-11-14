import { useState, useEffect } from "react";
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import ThemeToggle from "@/components/ThemeToggle";
import { useAuth } from "@/hooks/useAuth";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/Landing";
import AdminDashboard from "@/pages/AdminDashboard";
import Maintenance from "@/pages/Maintenance";
import Walkthroughs from "@/pages/Walkthroughs";
import Assets from "@/pages/Assets";
import Billing from "@/pages/Billing";
import Contacts from "@/pages/Contacts";
import ResidentDashboard from "@/pages/ResidentDashboard";
import SubmitRequest from "@/pages/SubmitRequest";
import MyRequests from "@/pages/MyRequests";
import AdminSettings from "@/pages/Settings";

function Router() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const [location] = useLocation();

  if (isLoading || !isAuthenticated) {
    return (
      <Switch>
        <Route path="/" component={Landing} />
        <Route component={Landing} />
      </Switch>
    );
  }

  const role = (user as any)?.role || "resident";

  if (role === "admin") {
    return (
      <Switch>
        <Route path="/" component={AdminDashboard} />
        <Route path="/maintenance" component={Maintenance} />
        <Route path="/walkthroughs" component={Walkthroughs} />
        <Route path="/assets" component={Assets} />
        <Route path="/billing" component={Billing} />
        <Route path="/contacts" component={Contacts} />
        <Route path="/settings" component={AdminSettings} />
        <Route component={NotFound} />
      </Switch>
    );
  }

  return (
    <Switch>
      <Route path="/" component={ResidentDashboard} />
      <Route path="/submit-request" component={SubmitRequest} />
      <Route path="/my-requests" component={MyRequests} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const [location] = useLocation();

  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  if (isLoading || !isAuthenticated) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <div className="min-h-screen">
            <Router />
          </div>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  const role = (user as any)?.role || "resident";

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SidebarProvider style={style as React.CSSProperties}>
          <div className="flex h-screen w-full">
            <AppSidebar role={role} currentPath={location} />
            <div className="flex flex-col flex-1 overflow-hidden">
              <header className="flex items-center justify-between p-4 border-b">
                <SidebarTrigger data-testid="button-sidebar-toggle" />
                <ThemeToggle />
              </header>
              <main className="flex-1 overflow-auto p-6">
                <Router />
              </main>
            </div>
          </div>
        </SidebarProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
